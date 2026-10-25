/**
 * 引用结构 Source 及其唯一转换器。
 * 边界：它既是检索结果的对外契约（WebSocket 的 chat:meta 事件先推引用、messages.sources 落库、
 *      前端 SourceCard 渲染），也是提示词里编号资料的来源；字段一旦增改，
 *      toSource 与所有消费方要同步。
 */
import { Document } from '@langchain/core/documents';

/**
 * 一条「被检索到并要展示给用户的资料片段」。
 * index 是回答里 [1] [2] 的编号，由 RetrievalService 过滤重排后从 1 开始赋值。
 */
export interface Source {
  index: number;
  documentId: string;
  filename: string;
  chunkId: string;
  chunkIndex: number;
  score: number;
  content: string;
}

/**
 * Document → 前端引用结构。
 * 与 KbRetriever 的 metadata 一一对应；单独导出是为了让「检索产物」和「落库/推送格式」
 * 只在这里转换一次，避免多处手工取字段导致引用错位。
 * 参数用 `Document<Source>` 而不是裸 `Document`：裸 `Document` 的 metadata 是
 * `Record<string, any>`，键名写错（如 documentId → docId）会被静默读成 undefined 并落进
 * messages.sources；换成泛型后 metadata 就是 Source，拼错的键与缺字段在 tsc 阶段直接报错
 * （@langchain/core 1.3 的约束是 `Metadata extends Record<string, any>`，Source 这个接口满足）。
 */
export function toSource(document: Document<Source>): Source {
  const { metadata } = document;
  return {
    index: metadata.index,
    documentId: metadata.documentId,
    filename: metadata.filename,
    chunkId: metadata.chunkId,
    chunkIndex: metadata.chunkIndex,
    score: metadata.score,
    content: document.pageContent,
  };
}
