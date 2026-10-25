/**
 * 检索服务（RAG 中的 R）：把用户问题变成向量，从 pgvector 里召回最相关的文档片段。
 *
 * 整体职责：
 * - 只做「召回」，不做提示词拼装、不做生成，职责单一便于替换检索策略
 * - 所有查询强制带 org_id + kb_id 双条件，保证多租户数据不可能跨库串味
 */
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../config/config.service';
import { DatabaseService } from '../database/database.service';
import { EmbeddingsService } from '../llm/embeddings.service';
import { Source } from './sources';

/** pgvector 查询返回的原始行（下划线命名，仅在本文件内部使用） */
interface RetrievalRow {
  id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  filename: string;
  score: number;
}

/**
 * 把 JS 数字数组转成 pgvector 能识别的文本字面量，例如 [0.1,0.2] -> "[0.1,0.2]"。
 * pg 驱动不做向量类型转换，必须自己拼成这个格式再用 $1::vector 强转。
 */
function vectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

@Injectable()
export class RetrievalService {
  constructor(
    private readonly db: DatabaseService,
    private readonly embeddings: EmbeddingsService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * 召回某个知识库中与问题最相关的片段。
   *
   * 步骤：
   * 1. 用新嵌入服务（EmbeddingsService，走 EMBEDDINGS_PROVIDER）把问题转成向量
   *    （bge-m3，1024 维）：这一步失败会**抛错并往上传播**，本方法不吞——
   *    条数/维度校验不过抛 LlmError（对应 EmbeddingsService.embed 的步骤 4「条数必须等于请求条数」
   *    与步骤 5「维度等于配置」），
   *    被中断抛 name 为 AbortError 的错误，provider 自己的 HTTP 失败则原样是 SDK 异常；
   *    只有「调用成功但向量数组为空」这一种情况才返回空结果 []（下面 `if (!embedding) return []`）
   * 2. 用余弦距离 `<=>` 在 chunks 表里取 Top-K：
   *    - 限定 org_id + kb_id，并且只取 status='ready' 的文档（处理中/失败的文档不参与检索）
   *    - `1 - 距离` 换算成相似度分数，越接近 1 越相似
   * 3. 按配置的最低分数阈值过滤掉弱相关结果，避免把无关内容塞进提示词
   * 4. 重排后从 1 开始编号，这个编号就是回答里 [1] [2] 引用的序号
   *
   * @param signal 原样转交给 EmbeddingsService（不改写、不吞异常）。
   *   provider 本身（@langchain/openai 1.7 的 OpenAIEmbeddings.embedDocuments 只收 texts）
   *   会忽略它，但 EmbeddingsService 在派发前有中断闸门、等待时又和 signal 竞争一次，
   *   所以 abort 后调用方能立刻拿到 AbortError；只是已在飞的 HTTP 仍会继续跑完（结果没人要）。
   */
  async retrieve(
    orgId: string,
    kbId: string,
    question: string,
    signal?: AbortSignal,
  ): Promise<Source[]> {
    // 步骤 1：问题向量化
    const [embedding] = await this.embeddings.embed([question], signal);
    if (!embedding) return [];

    // 步骤 2：pgvector 近邻检索（Top-K 由 RETRIEVAL_TOP_K 配置，默认 6）
    const result = await this.db.query<RetrievalRow>(
      `SELECT c.id, c.document_id, c.chunk_index, c.content, d.filename,
              1 - (c.embedding <=> $1::vector) AS score
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
       WHERE c.org_id = $2 AND c.kb_id = $3 AND d.status = 'ready'
       ORDER BY c.embedding <=> $1::vector
       LIMIT $4`,
      [
        vectorLiteral(embedding),
        orgId,
        kbId,
        this.config.retrievalTopK,
      ],
    );

    return result.rows
      // 步骤 3：低于阈值（默认 0.2）的结果视为不相关，直接丢弃
      .map((row) => ({
        documentId: row.document_id,
        filename: row.filename,
        chunkId: row.id,
        chunkIndex: row.chunk_index,
        score: Number(row.score),
        content: row.content,
      }))
      .filter((row) => row.score >= this.config.retrievalMinScore)
      // 步骤 4：从 1 开始编号，供回答中的 [n] 引用与前端引用卡片对齐
      .map((row, index) => ({ index: index + 1, ...row }));
  }
}
