/**
 * 入库服务：把一份已上传的原文件变成「可检索的向量片段」，并全过程维护 documents.status。
 *
 * 职责边界：
 * - 只做「解析 → 切分 → 嵌入 → 落库 → 广播」这条串联流水线；
 *   解码细节在 ParserService（B3）、切分策略在 splitToChunks（B4）、批量与维度校验在 EmbeddingsService（B1）
 * - 不接收 HTTP 请求：调用方是 IngestionProcessor（pg-boss worker）与 e2e 里的直接调用，
 *   入参只有四个 id，文件内容一律按 documents.storage_key 回读，任务体不随文档大小膨胀
 * - 不删原文件、不动权限；删除文档由 documents 侧负责
 */
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/config.service';
import { DatabaseService } from '../database/database.service';
import { EmbeddingsService } from '../llm/embeddings.service';
import { ParserService } from './parsing/parser.service';
import { splitToChunks } from './parsing/chunker';
import { IngestJob } from '../queue/queue.constants';

/** 入库需要知道的文档列（只取这几列，别把整行拖进流程） */
interface DocumentForIngest {
  id: string;
  org_id: string;
  kb_id: string;
  uploaded_by: string | null;
  storage_key: string;
}

/**
 * 把 JS 数字数组转成 pgvector 认的文本字面量，例如 [0.1,0.2] -> "[0.1,0.2]"。
 * pg 驱动不做向量类型转换，必须自己拼好再用 $n::vector 强转（与 retrieval.service 同一套写法）。
 */
function vectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

/**
 * 把任意异常压成可入库的错误摘要。
 * 截到 500 字符：解析/嵌入的报错常整段带上下文（loader 的原始 message 可能极长），
 * 直接写进 documents.error 会把这一列塞满、也让前端提示没法看。
 */
function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500);
}

@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly parser: ParserService,
    private readonly embeddings: EmbeddingsService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * 处理一份文档的入库。
   *
   * 步骤：
   * 1. 按 orgId + documentId 取文档（带 org 条件，防止跨组织误处理），取不到说明已被删除，直接返回
   * 2. 状态置 processing 并广播（前端实时看到「解析中」）
   * 3. 用 LangChain loader 读出 Document[]，拼成整篇文本后按 CHUNK_SIZE / CHUNK_OVERLAP 切成片段
   *    （切分参数已在 AppConfigService 启动时校验过，这里不必再兜异常值）
   * 4. 切不出任何片段就按「内容问题」终止：没有内容可嵌入，重试一万次也一样
   * 5. 批量嵌入：EmbeddingsService 内部按 16 条一批调用 provider，并保证返回条数与
   *    片段数一一对应、每条维度等于配置，所以这里不需要再自查数量或维度
   * 6. 单事务内：删旧片段 → 逐条插入新片段 → 状态置 ready 写 chunk_count
   *    （删+插放同一事务，避免重试时出现半份片段）
   * 7. 广播 ready；任何失败都状态置 failed 并广播
   * 8. 内容类错误（BadRequestException）不再上抛，避免队列对「扫描件」这类永久问题反复重试；
   *    其余错误（连不上库、模型服务 5xx 等）原样抛出，交给 pg-boss 重试
   */
  async process(job: IngestJob): Promise<void> {
    // 步骤 1：查文档，org 条件写在 WHERE 里而不是靠调用方保证
    const result = await this.db.query<DocumentForIngest>(
      `SELECT id, org_id, kb_id, uploaded_by, storage_key
       FROM documents WHERE id = $1 AND org_id = $2`,
      [job.documentId, job.orgId],
    );
    const document = result.rows[0];
    if (!document) return;

    // 步骤 2：先亮出「解析中」，前端和列表轮询都靠这次状态
    await this.updateStatus(document, 'processing', 0, null);

    try {
      // 步骤 3：解析成 Document[]，再按 LangChain 的每篇结构拼回整篇文本交给切分器
      //（loader 目前每份文件只返回一个 Document，join 只是把「多页/多篇」这种数组形态收敛成纯文本）
      const docs = await this.parser.load(document.storage_key);
      const text = docs.map((doc) => doc.pageContent).join('\n');
      const chunks = await splitToChunks(
        text,
        this.config.chunkSize,
        this.config.chunkOverlap,
      );
      // 步骤 4：空片段属于内容问题，用 400 走「终端失败」分支
      if (!chunks.length) {
        throw new BadRequestException('文档没有可用于切分的内容');
      }

      // 步骤 5：批量嵌入，向量下标与 chunks 下标严格对齐（步骤 6 按下标配对写库）
      const vectors = await this.embeddings.embed(chunks);

      // 步骤 6：删旧 + 插新 + 置 ready 必须在同一事务里，中途失败就整体回滚
      await this.db.withTransaction(async (client) => {
        await client.query('DELETE FROM chunks WHERE document_id = $1', [
          document.id,
        ]);
        for (let index = 0; index < chunks.length; index += 1) {
          await client.query(
            `INSERT INTO chunks
             (org_id, kb_id, document_id, chunk_index, content, embedding)
             VALUES ($1, $2, $3, $4, $5, $6::vector)`,
            [
              document.org_id,
              document.kb_id,
              document.id,
              index,
              chunks[index],
              vectorLiteral(vectors[index]),
            ],
          );
        }
        await client.query(
          `UPDATE documents
           SET status = 'ready', error = NULL, chunk_count = $1, updated_at = now()
           WHERE id = $2 AND org_id = $3`,
          [chunks.length, document.id, document.org_id],
        );
      });

      // 步骤 7：成功广播（ready 与 chunk_count 是在事务里写的，这里只负责通知）
      await this.notify(document, 'ready', chunks.length, null);
    } catch (error) {
      const message = errorMessage(error);
      this.logger.warn(`ingestion failed for ${document.id}: ${message}`);
      // 步骤 7：失败也要落库并广播，否则前端会一直停在「解析中」
      await this.updateStatus(document, 'failed', 0, message);
      // 步骤 8：内容类错误重抛只会白耗队列重试次数，其它错误保持可重试语义
      if (!(error instanceof BadRequestException)) {
        throw error;
      }
    }
  }

  /**
   * 写中间态（processing / failed）并广播。
   * ready 不走这里——它和 chunk_count 必须在插入片段的那个事务里一起提交。
   */
  private async updateStatus(
    document: DocumentForIngest,
    status: 'processing' | 'failed',
    chunkCount: number,
    error: string | null,
  ) {
    await this.db.query(
      `UPDATE documents
       SET status = $1, error = $2, chunk_count = $3, updated_at = now()
       WHERE id = $4 AND org_id = $5`,
      [status, error, chunkCount, document.id, document.org_id],
    );
    await this.notify(document, status, chunkCount, error);
  }

  /**
   * 用 pg_notify 把状态变化推给实时网关（同一台 PG、同一个连接池，不需要额外消息中间件）。
   * 载荷里带上 uploadedBy：网关据此决定除了知识库房间外，还要额外推给上传者本人。
   */
  private async notify(
    document: DocumentForIngest,
    status: 'processing' | 'ready' | 'failed',
    chunkCount: number,
    error: string | null,
  ) {
    await this.db.query('SELECT pg_notify($1, $2)', [
      'kr_document_status',
      JSON.stringify({
        documentId: document.id,
        orgId: document.org_id,
        kbId: document.kb_id,
        uploadedBy: document.uploaded_by,
        status,
        chunkCount,
        error,
      }),
    ]);
  }
}
