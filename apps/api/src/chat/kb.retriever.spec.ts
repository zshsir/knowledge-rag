/**
 * KbRetriever 单测：只验「Source -> Document -> Source」这一层包装。
 * 检索本身（SQL/阈值/编号）由 RetrievalService 负责，这里用假实现替换，
 * 目的是把 LangChain 外壳与数据库解耦：不连库、不打模型，也能钉住引用字段的映射。
 * 为什么要有这一层（而不是直接用 PGVectorStore）：见 kb.retriever.ts 文件头——现有 chunks 表
 * 带 org_id/kb_id/document_id 外键、HNSW 索引与 documents.status='ready' 过滤，交给 PGVectorStore
 * 等于丢掉级联清理、状态过滤与「数据库列级」的多租户隔离。
 * 因此本文件能证明的只有「外壳不丢字段、不丢 id、不丢 signal」；
 * 隔离与阈值是否写对取决于 RetrievalService 的 SQL，那里没有单测（fake 想返回什么就返回什么）。
 * 另两条被钉住的迁移期结论：唯一的公开入口是 invoke()（B8 已删掉临时别名 getRelevantDocuments）、
 * core 1.3 的 BaseRetriever.invoke 不读 RunnableConfig.signal，取消通道只有构造期绑定的那一个。
 */
import { KbRetriever } from './kb.retriever';
import { Source, toSource } from './sources';

// 显式标注成 Source：少字段/拼错键名会在 tsc 阶段就报错，
// 于是下面 toSource(doc) 的往返断言是「按 Source 类型检查过的」，而不是运行时才看形状
const source: Source = {
  index: 1,
  documentId: 'd1',
  filename: 'a.md',
  chunkId: 'c1',
  chunkIndex: 0,
  score: 0.87,
  content: '资料内容',
};

describe('KbRetriever', () => {
  // 回归点：外壳的参数与产出形态。第 4 个实参在「没有 signal」时也要显式是 undefined——
  // Jest 按实参数组逐项比较，把这次调用改成三个实参就会红，等于把调用形状钉死（有意为之）；
  // metadata 用 toMatchObject 而不是整对象相等：这里只关心引用要素能对上，
  // 完整字段集的还原交给下面第三条 toSource 用例
  it('把检索结果转成带 metadata 的 LangChain Document', async () => {
    const retrieval = { retrieve: jest.fn().mockResolvedValue([source]) };
    const retriever = new KbRetriever(retrieval as never, { orgId: 'o1', kbId: 'k1' });

    // 走 invoke()：@langchain/core 1.3 的 BaseRetriever 只有这个公开入口
    // （它内部再调 _getRelevantDocuments）；B6 期间为兼容计划里的旧名字临时加过
    // getRelevantDocuments 别名，B8 已随旧实现一起删掉，不要再往回加。
    const docs = await retriever.invoke('问题');

    // orgId/kbId 来自构造参数，signal 未传时也要原样以 undefined 落到 retrieve 的第 4 个参数
    expect(retrieval.retrieve).toHaveBeenCalledWith('o1', 'k1', '问题', undefined);
    expect(docs[0].pageContent).toBe('资料内容');
    expect(docs[0].metadata).toMatchObject({ index: 1, filename: 'a.md', score: 0.87 });
    // 老名字必须彻底消失：留着一个绕过 Runnable 的入口，接进链时就会走出一条没有回调的路
    expect(
      (retriever as unknown as Record<string, unknown>)['getRelevantDocuments'],
    ).toBeUndefined();
  });

  it('构造函数绑定的 AbortSignal 原样交给 RetrievalService（同一个对象）', async () => {
    const retrieval = { retrieve: jest.fn().mockResolvedValue([source]) };
    const controller = new AbortController();
    const retriever = new KbRetriever(retrieval as never, {
      orgId: 'o1',
      kbId: 'k1',
      signal: controller.signal,
    });

    // 第二个实参故意传一个带 signal 的 RunnableConfig：BaseRetriever.invoke 读不到它
    // （core 1.3 只做 callbacks + _getRelevantDocuments），所以「config.signal 不算数、
    // 只有构造期绑定的 signal 是取消通道」这件事是被下面这条断言实测钉住的
    await retriever.invoke('问题', { signal: new AbortController().signal });

    // toBe（不是 toEqual）：中断必须靠同一个 signal 实例传下去——
    // 换一个新的 signal 对象（比如上面那个 config.signal）会让「停止生成」再也传不到
    // EmbeddingsService 的中断闸门。
    expect(retrieval.retrieve.mock.calls[0][3]).toBe(controller.signal);
    expect(retrieval.retrieve).toHaveBeenCalledWith('o1', 'k1', '问题', controller.signal);
  });

  // 回归点：Source ⇄ Document 往返必须无损，这条是 messages.sources 与 chat:meta 引用的唯一防线。
  // 用整对象 toEqual 而不是字段抽查：少任一键都会静默落进库——content 是卡片展开的正文，
  // chunkId 是前端引用列表的 React key（apps/web/src/features/chat/ChatPage.tsx:82）
  it('toSource 能从 Document 还原出前端需要的引用结构', async () => {
    const retrieval = { retrieve: jest.fn().mockResolvedValue([source]) };
    const retriever = new KbRetriever(retrieval as never, { orgId: 'o1', kbId: 'k1' });
    const [doc] = await retriever.invoke('问题');
    // metadata 里多带一份 content 不影响还原：toSource 的字段集就是 Source 的字段集
    // doc 的静态类型是 Document<Source>，因此这一步连同 toSource 的入参一起受类型检查
    expect(toSource(doc)).toEqual(source);
  });
});
