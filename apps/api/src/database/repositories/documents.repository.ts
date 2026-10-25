/**
 * documents 表仓储：只负责 SQL，不含业务规则。
 *
 * 隔离边界：
 * - 除 insert 外每个方法都以 org_id 作为 WHERE 条件：org_id 条件是多租户的硬边界，去掉就会跨组织读写数据
 *   （documents 表冗余存了 org_id，正是为了让所有查询都能只走一张表就完成隔离判断）
 * - insert 是唯一的例外：那里的 org_id 是写进新行的值，不是过滤条件，
 *   隔离靠调用方（documents.service）传入自己那套路由参数里的 orgId，本方法无从复核
 * - 不校验「这个人对该知识库有没有 editor 权限」，也不管状态机怎么流转，那些属于 documents / ingestion 服务
 * - 不碰磁盘文件：storageKey 只是一个键，删除文件由 StorageService 负责
 */
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database.service';

/** 文档处理状态机：queued 待入库 → processing 解析中 → ready 可检索 / failed 失败可重试 */
export type DocumentStatus = 'queued' | 'processing' | 'ready' | 'failed';

/** 文档行（驼峰，可直接给前端） */
export interface DocumentRow {
  id: string;
  orgId: string;
  kbId: string;
  uploadedBy: string | null;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
  status: DocumentStatus;
  error: string | null;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
}

/** documents 表原始行（下划线命名，仅本文件内部使用） */
interface RawDocumentRow {
  id: string;
  org_id: string;
  kb_id: string;
  uploaded_by: string | null;
  filename: string;
  mime_type: string;
  /** bigint 列：pg 驱动默认把 bigint 作为字符串返回，避免超出 JS 安全整数，所以这里不是 number */
  size_bytes: string;
  storage_key: string;
  status: DocumentStatus;
  error: string | null;
  chunk_count: number;
  created_at: string;
  updated_at: string;
}

function mapDocument(row: RawDocumentRow): DocumentRow {
  return {
    id: row.id,
    orgId: row.org_id,
    kbId: row.kb_id,
    uploadedBy: row.uploaded_by,
    filename: row.filename,
    mimeType: row.mime_type,
    // 必须显式 Number()：size_bytes 是 bigint，不转换的话前端拿到的是字符串，做体积比较时会按字符串比大小
    sizeBytes: Number(row.size_bytes),
    storageKey: row.storage_key,
    status: row.status,
    error: row.error,
    chunkCount: row.chunk_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

@Injectable()
export class DocumentsRepository {
  constructor(private readonly db: DatabaseService) {}

  /**
   * 登记一条已落盘但尚未入库的文档，初始状态写死 'queued'。
   * id 由调用方生成（与文件落盘用同一个 id）：先写磁盘再写库，
   * 库里这条记录就是「这个文件等待被解析」的凭据，worker 只认库里的状态。
   */
  async insert(input: {
    id: string;
    orgId: string;
    kbId: string;
    uploadedBy: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    storageKey: string;
  }): Promise<DocumentRow> {
    const result = await this.db.query<RawDocumentRow>(
      `INSERT INTO documents
       (id, org_id, kb_id, uploaded_by, filename, mime_type, size_bytes, storage_key, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'queued')
       RETURNING *`,
      [
        input.id,
        input.orgId,
        input.kbId,
        input.uploadedBy,
        input.filename,
        input.mimeType,
        input.sizeBytes,
        input.storageKey,
      ],
    );
    return mapDocument(result.rows[0]);
  }

  /** 列出某知识库的文档，最新的在前。org_id + kb_id 双条件，跨库跨组织都拿不到别人的文档 */
  async listForKb(orgId: string, kbId: string): Promise<DocumentRow[]> {
    const result = await this.db.query<RawDocumentRow>(
      `SELECT * FROM documents
       WHERE org_id = $1 AND kb_id = $2
       ORDER BY created_at DESC`,
      [orgId, kbId],
    );
    return result.rows.map(mapDocument);
  }

  /** 按 (documentId, orgId) 取单个文档；返回 null 表示不存在或不属于本组织，对外一律当「不存在」 */
  async findById(orgId: string, documentId: string): Promise<DocumentRow | null> {
    const result = await this.db.query<RawDocumentRow>(
      'SELECT * FROM documents WHERE id = $1 AND org_id = $2',
      [documentId, orgId],
    );
    return result.rows[0] ? mapDocument(result.rows[0]) : null;
  }

  /**
   * 删除文档元数据行。
   * org_id 条件是硬边界，去掉就能凭 id 删掉别人的文档。
   * chunks 靠外键 ON DELETE CASCADE 一并清理；磁盘文件不归本方法管。
   */
  async delete(orgId: string, documentId: string): Promise<void> {
    await this.db.query('DELETE FROM documents WHERE id = $1 AND org_id = $2', [
      documentId,
      orgId,
    ]);
  }

  /**
   * 取某文档的全部切片正文，按切分顺序排列，供「查看原文分片」页。
   * chunks 表冗余了 org_id，所以这里同样带 org_id 硬边界——不 join documents 也能挡住跨组织读取。
   * 不返回 embedding：向量列很宽，取出来只会白占内存，本方法只需要文本。
   */
  async listChunks(orgId: string, documentId: string) {
    const result = await this.db.query<{
      id: string;
      chunk_index: number;
      content: string;
    }>(
      `SELECT id, chunk_index, content
       FROM chunks
       WHERE org_id = $1 AND document_id = $2
       ORDER BY chunk_index ASC`,
      [orgId, documentId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      chunkIndex: row.chunk_index,
      content: row.content,
    }));
  }

  /**
   * worker 回写处理结果：状态 + 错误信息 + 切片数。
   * 三个字段一次写完，避免出现「状态已 ready 但 chunk_count 还是 0」的中间态。
   * WHERE 带 org_id：即使 worker 拿错 id，也不可能改到别的组织的文档。
   */
  async updateStatus(
    orgId: string,
    documentId: string,
    status: DocumentStatus,
    error: string | null,
    chunkCount = 0,
  ): Promise<void> {
    await this.db.query(
      `UPDATE documents
       SET status = $1, error = $2, chunk_count = $3, updated_at = now()
       WHERE id = $4 AND org_id = $5`,
      [status, error, chunkCount, documentId, orgId],
    );
  }

  /**
   * 把失败的文档重新排队。
   * WHERE id = $1 AND org_id = $2：org_id 条件是硬边界，去掉就能凭 id 把别人的文档推回队列，
   * 顺带触发一次跨组织的重新入库。
   * 只重置 status 并清空 error（不动已有 chunk_count）：真正清理旧切片由 worker 重做入库时负责，
   * 这里先把状态推回 queued，用户才能立刻在列表上看到「处理中」。
   */
  async requeue(orgId: string, documentId: string): Promise<DocumentRow | null> {
    const result = await this.db.query<RawDocumentRow>(
      `UPDATE documents
       SET status = 'queued', error = NULL, updated_at = now()
       WHERE id = $1 AND org_id = $2
       RETURNING *`,
      [documentId, orgId],
    );
    // 没命中就返回 null，交由服务层抛 404：重试一个不存在的文档不该静默成功
    return result.rows[0] ? mapDocument(result.rows[0]) : null;
  }
}
