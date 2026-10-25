/**
 * 知识库检索器：LangChain BaseRetriever 的自定义实现。
 * 为什么不用 PGVectorStore：它按自己的 DDL 建表（只有 id/content/metadata jsonb/embedding 四列），
 *   而现有 chunks 表带 org_id/kb_id/document_id 三对外键（ON DELETE CASCADE）、chunk_index、
 *   HNSW 余弦索引和 documents.status='ready' 的 JOIN；交给它接管等于
 *   丢掉级联清理与状态过滤，多租户隔离还会从「数据库列 + WHERE」降级成 JSONB 文本比较，
 *   并且要先把生产数据全量重嵌入。
 * 因此这里保留手写 pgvector SQL（RetrievalService），只套一层 LangChain 外壳，
 *   让检索能作为标准 Runnable 接入链，同时隔离与状态过滤不降级。
 * 边界：本文件只做「Source -> Document」的包装，不做召回策略、不碰提示词、不写 SQL；
 *   调用方是对话链（Task 13/B7），落库/推送用的引用结构由 sources.ts 的 toSource 还原。
 */
import { Document } from '@langchain/core/documents';
import { CallbackManagerForRetrieverRun } from '@langchain/core/callbacks/manager';
import { BaseRetriever } from '@langchain/core/retrievers';
import { RetrievalService } from './retrieval.service';
import { Source } from './sources';

export interface KbRetrieverOptions {
  orgId: string;
  kbId: string;
  signal?: AbortSignal;
}

export class KbRetriever extends BaseRetriever<Source> {
  // LangChain 的序列化路径：Serializable 把 lc_namespace 声明为抽象字段，子类必须给出，
  // 否则 typecheck 报「未实现继承的抽象成员」。它是字段初始化器、在 super() 之后才赋值，
  // 而 core 只在 toJSON()/lc_id 读取器里惰性使用它（构造期不读），因此这个顺序是安全的。
  lc_namespace = ['knowledge-rag', 'chat'];

  constructor(
    private readonly retrieval: RetrievalService,
    private readonly options: KbRetrieverOptions,
  ) {
    super();
  }

  /**
   * LangChain 约定的实现点：唯一入口是 Runnable 标准的 `invoke(query)`，它内部回调到这里。
   * 步骤：
   * 1. 委托 RetrievalService：SQL 只做「按 org/kb 过滤 + 只取 ready 文档 + 按余弦距离取 Top-K，
   *    并算出 1 - 距离作为 score」（retrieval.service.ts:72-86）；
   *    阈值比较 `score >= retrievalMinScore` 与引用编号 1..n 都在 JS 侧做（:88-100），不在 SQL 里
   * 2. 把每条结果包成 Document：pageContent 是片段原文，metadata 带引用所需的全部字段
   * 3. orgId/kbId 在构造时绑定、每个请求新建实例：隔离真正落在 RetrievalService 的
   *    SQL（WHERE c.org_id = $2 AND c.kb_id = $3）上，这里只保证不会把上一个请求的
   *    组织/知识库 id 带进下一次检索（实例被复用才会串，所以我们不注册成单例）。
   * 类型：泛型参数是 Source（`BaseRetriever<Source>`），于是 metadata 就是 Source 本身，
   *   而不是 `Record<string, any>`；键名写错会在 tsc 阶段炸掉，不会静默把 undefined 落进
   *   messages.sources（还原用的 toSource 同样按 Source 检查，见 sources.ts）。
   * 注意：@langchain/core 1.3 把该方法的声明留成 public（源码注释写着「下个主版本才改抽象」），
   *      所以这里必须写成 public，protected 会因「子类收窄了基类的可见性」直接编译失败。
   * 关于取消（重要，容易误以为给 invoke 传 config.signal 就能中断）：core 1.3 的
   *   BaseRetriever.invoke（node_modules/@langchain/core/dist/retrievers/index.js:81-93）
   *   只做 callbacks + _getRelevantDocuments，没有 RunnableSequence.invoke 那一步
   *   raceWithSignal(promise, config.signal)（dist/runnables/base.js:944）。所以中断只能来自
   *   构造时绑定的 options.signal：它经本方法交给 RetrievalService，再交给 EmbeddingsService
   *   的派发前闸门 + abort 竞争（embeddings.service.ts）。
   */
  async _getRelevantDocuments(
    query: string,
    _callbacks?: CallbackManagerForRetrieverRun,
  ): Promise<Document<Source>[]> {
    const sources = await this.retrieval.retrieve(
      this.options.orgId,
      this.options.kbId,
      query,
      this.options.signal,
    );
    return sources.map(
      (source) =>
        new Document<Source>({
          pageContent: source.content,
          metadata: { ...source },
        }),
    );
  }
}
