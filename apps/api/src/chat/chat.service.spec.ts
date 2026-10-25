/**
 * ChatService 单测：只验「编排顺序与落库语义」，不连库、不打模型。
 * 依赖全是假实现：检索侧注入假的 RetrievalService.retrieve（KbRetriever 内部只调它），
 * 生成侧注入假的 ChatModelService.stream。
 * 这里钉住的是前端与历史数据依赖的硬契约：meta 先于第一个 delta、一个问题只检索一次、
 * 同一批 Source 同时喂给引用/落库/提示词、无结果不调模型、中断保留半条、空回答不落库，
 * 以及「中断落在检索阶段也必须以 cancelled 收尾」「生成调用拿到的是同一个 AbortSignal」。
 */
import { ChatService, NO_RESULTS_ANSWER } from './chat.service';
import { ChatMessage } from '../llm/llm.types';
import { Source } from './sources';

const source: Source = {
  index: 1,
  documentId: 'd1',
  filename: 'a.md',
  chunkId: 'c1',
  chunkIndex: 0,
  score: 0.9,
  content: '资料',
};

/** 按顺序吐增量的假流（默认行为：正常生成完就结束） */
function tokens(...items: string[]): AsyncGenerator<string> {
  return (async function* () {
    for (const item of items) yield item;
  })();
}

/** 中断场景要的错误：ChatService 靠 name === 'AbortError' 或 signal.aborted 判定中断 */
function abortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

interface StreamContext {
  /** 触发本次请求的中止，等价于用户点「停止生成」 */
  abort: () => void;
}

/** 假依赖的行为开关；两个函数式选项都能拿到同一个 controller 的中止句柄 */
interface DepsOptions {
  /** 检索返回的资料列表；不传则用模块顶部那条 source（不传 sources 也不传 retrieve 时） */
  sources?: Source[];
  /** 覆盖检索阶段的行为：用于构造「嵌入/检索期间被中断」和「检索故障」两条失败路径 */
  retrieve?: (context: StreamContext) => Promise<Source[]>;
  /** 覆盖生成阶段的增量流：用于构造「吐了半条才中断」「一上来就中断」等场景 */
  stream?: (context: StreamContext) => AsyncGenerator<string>;
}

/**
 * 每个用例共用的一组假依赖；spies 供断言，promptCalls 用于检查提示词内容。
 * 五个 fake 各自顶替：会话表/消息表（不连库，避免测试依赖 PostgreSQL 与迁移）、
 * RetrievalService（不跑 pgvector SQL 与查询嵌入）、ChatModelService（不打真实模型：
 * CI 不能依赖外部网络与额度，也不该为编排测试烧一次真调用）、KbAccessService（鉴权结果固定 viewer）。
 * 注意 KbRetriever 与 buildRagMessages 用的是真实现——检索外壳与提示编排正是被测对象的一部分，
 * 只有它们下游的两个服务被换成假的。
 */
function createDeps(options?: DepsOptions) {
  const controller = new AbortController();
  const conversations = {
    findOwned: jest.fn().mockResolvedValue({ id: 'c1' }),
    findOwnedById: jest.fn(),
    create: jest.fn().mockResolvedValue({ id: 'c1' }),
    touch: jest.fn(),
  };
  const messages = {
    recent: jest.fn().mockResolvedValue([]),
    insert: jest
      .fn()
      .mockResolvedValueOnce({ id: 'u1' })
      .mockResolvedValueOnce({ id: 'a1' }),
  };
  const retrieval = {
    // 形参按 RetrievalService.retrieve 的真实签名写全（含第 4 个 signal）：
    // 一是让下面的 toHaveBeenCalledWith 受类型检查，二是默认实现返回的资料也照旧可控
    // 用例传了 retrieve 就改走它自己的实现（检索阶段的中断与故障都只能从这里造，
    // 真链路是 KbRetriever -> RetrievalService，ChatService 只认 retrieve 的失败形状）
    retrieve: jest.fn(
      (
        _orgId: string,
        _kbId: string,
        _question: string,
        _signal?: AbortSignal,
      ) =>
        options?.retrieve
          ? options.retrieve({ abort: () => controller.abort() })
          : Promise.resolve(
              options?.sources === undefined ? [source] : options.sources,
            ),
    ),
  };
  const promptCalls: ChatMessage[][] = [];
  const chatModel = {
    // 形参刻意不读 signal：生成内容由 options.stream 决定，这个假实现不需要真的能被打断。
    // 写全第二个形参只是为了让假依赖的形状和 ChatModelService.stream 一眼对得上，
    // 它**不是**类型层面的保护：下面 `chatModel as never` 已经把形状检查整个关掉了，
    // 而且真实签名的 signal 本是可选参数，删掉这个形参 tsc 也不会报错。
    // 真正的守卫是运行时断言——'passes the same AbortSignal object to ChatModelService.stream'
    // 那条用例里的 toBe（见本文件末尾）。
    stream: jest.fn(async function* (
      prompt: ChatMessage[],
      _signal?: AbortSignal,
    ) {
      promptCalls.push(prompt);
      const deltas = options?.stream?.({ abort: () => controller.abort() });
      if (!deltas) return;
      yield* deltas;
    }),
  };
  const kbAccess = { require: jest.fn().mockResolvedValue('viewer') };
  const service = new ChatService(
    conversations as never,
    messages as never,
    retrieval as never,
    chatModel as never,
    kbAccess as never,
  );
  return {
    service,
    controller,
    conversations,
    messages,
    retrieval,
    chatModel,
    promptCalls,
    kbAccess,
  };
}

/** 发起一次对话的公共入参，用例只覆盖自己关心的字段 */
function requestParams(
  deps: ReturnType<typeof createDeps>,
  overrides?: Partial<{ conversationId: string; question: string }>,
) {
  return {
    user: { id: 'u1', email: 'a@test.local', name: 'A' },
    orgId: 'o1',
    kbId: 'k1',
    conversationId: 'c1',
    question: '资料是什么？',
    signal: deps.controller.signal,
    onMeta: jest.fn(),
    onDelta: jest.fn(),
    ...overrides,
  };
}

describe('ChatService', () => {
  // 回归点：检索空手时不许烧一次模型调用（chat.service.ts#run 的空结果分支），但仍要走完
  // 「建会话 → 落固定回答 → touch」——这条最容易被「没资料就早退」的改法破坏，
  // 早退会让前端拿不到 assistantMessageId、气泡无法定位，历史里也缺一轮问答。
  // 注意 onMeta 依然被调用（sources: []）：它在 :199 无条件推，早于空结果分支
  it('returns the fixed answer without calling the LLM when nothing is relevant', async () => {
    const deps = createDeps({ sources: [] });
    const onMeta = jest.fn();
    const onDelta = jest.fn();

    const result = await deps.service.run({
      ...requestParams(deps, { conversationId: undefined, question: 'unknown' }),
      onMeta,
      onDelta,
    });

    expect(deps.chatModel.stream).not.toHaveBeenCalled();
    expect(result.answer).toBe(NO_RESULTS_ANSWER);
    expect(result.assistantMessageId).toBe('a1');
    expect(onMeta).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'c1', sources: [] }),
    );
    expect(onDelta).toHaveBeenCalledWith(NO_RESULTS_ANSWER);
    // 无结果也要「建会话 → 落固定回答 → touch」：前端靠 assistantMessageId 定位气泡
    expect(deps.conversations.create).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'o1', kbId: 'k1', userId: 'u1' }),
    );
    expect(deps.messages.insert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        role: 'assistant',
        content: NO_RESULTS_ANSWER,
        sources: [],
      }),
    );
    expect(deps.conversations.touch).toHaveBeenCalledWith('c1');
  });

  // 回归点：门槛等级是 viewer（问答是只读操作，不该要求 editor），且历史窗口写死 6 条
  //（chat.service.ts#run 里「历史窗口固定 6 条」那两行）。等级被抬高会让 viewer 成员直接问不了题；
  // 提示链内部还有一道同样的截断（rag-prompt.ts:24），所以这里的 6 钉的是「取数形状」，
  // 真要改窗口，两处得一起改（那两行的注释也是这么写的）
  it('requires viewer access and reads only the last 6 history rows', async () => {
    const deps = createDeps({ stream: () => tokens('好') });
    await deps.service.run(requestParams(deps));
    expect(deps.kbAccess.require).toHaveBeenCalledWith(
      'o1',
      'k1',
      'u1',
      'viewer',
    );
    expect(deps.messages.recent).toHaveBeenCalledWith('c1', 6);
  });

  // 回归点：spec §5.3 的两条迁移保证——「一轮问答只检索一次」与「meta 严格先于第一个 delta」。
  // 事件序列用同一条 push 顺序记录，所以 meta 挪到 delta 之后（或检索拆成两次）都会红；
  // 第 4 个实参断言同时钉住「run() 把用户的 signal 交给了检索」，与最后一条用例是同一手法
  it('retrieves once and emits meta before the first delta', async () => {
    const deps = createDeps({ stream: () => tokens('你', '好') });
    const events: string[] = [];
    await deps.service.run({
      ...requestParams(deps),
      onMeta: () => events.push('meta'),
      onDelta: () => events.push('delta'),
    });
    // 只检索一次：多一次就多一次向量与 SQL，还会让引用卡片与提示词编号错位
    expect(deps.retrieval.retrieve).toHaveBeenCalledTimes(1);
    expect(deps.retrieval.retrieve).toHaveBeenCalledWith(
      'o1',
      'k1',
      '资料是什么？',
      deps.controller.signal,
    );
    // 顺序就是协议：前端先渲染引用卡片，再开始打字
    expect(events).toEqual(['meta', 'delta', 'delta']);
  });

  // 回归点：happy path 的三处一致性——推给前端的引用、落库的 sources、喂给提示词的资料
  // 必须是同一批 Source 对象（promptCalls 里能看到 [1] 的头行）。
  // 这条同时钉住 answer 的逐段拼接（'你'+'好' → '你好'）与 interrupted=false
  it('streams an answer with sources and persists it', async () => {
    const deps = createDeps({ stream: () => tokens('你', '好') });
    const onMeta = jest.fn();
    const onDelta = jest.fn();
    const result = await deps.service.run({
      ...requestParams(deps),
      onMeta,
      onDelta,
    });
    expect(result.answer).toBe('你好');
    expect(result.interrupted).toBe(false);
    expect(result.sources).toEqual([source]);
    expect(onMeta).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'c1', sources: [source] }),
    );
    expect(onDelta.mock.calls.map((call) => call[0])).toEqual(['你', '好']);
    expect(deps.messages.insert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        role: 'assistant',
        content: '你好',
        sources: [source],
      }),
    );
    expect(deps.conversations.touch).toHaveBeenCalledWith('c1');
    // 提示词里的编号资料必须来自同一批 Source：[1] 指向的就是卡片上那一条
    expect(deps.promptCalls).toHaveLength(1);
    expect(deps.promptCalls[0][0].content).toContain('[1] 文件：a.md（片段 0）\n资料');
    expect(deps.promptCalls[0].at(-1)).toEqual({
      role: 'user',
      content: '资料是什么？',
    });
  });

  // 回归点：设计文档 §5.3 第 5 点「中断时把已生成部分落库并标记 interrupted」——吐了半条才停，
  // 那半条必须进 messages（content '半' + interrupted:true）并 touch 会话，
  // 否则用户回头看不到自己刚叫停的内容，历史里还出现「有问无答」
  it('keeps the half-generated answer when the stream is aborted', async () => {
    const deps = createDeps({
      stream: ({ abort }) =>
        (async function* () {
          yield '半';
          abort();
          throw abortError();
        })(),
    });
    const result = await deps.service.run(requestParams(deps));
    expect(result.answer).toBe('半');
    expect(result.interrupted).toBe(true);
    expect(result.assistantMessageId).toBe('a1');
    expect(deps.messages.insert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        role: 'assistant',
        content: '半',
        sources: [source],
        interrupted: true,
      }),
    );
    expect(deps.conversations.touch).toHaveBeenCalledWith('c1');
  });

  // 回归点：一个 token 都没吐就被叫停 ⇒ 不落助手行、不 touch（chat.service.ts#run 里 interrupted 且 answer 为空那条分支），
  // 只留用户那一行。落一条空气泡会让历史回放出现「空回答」，前端还得猜它是不是被中断的
  it('persists nothing and returns a null message id when aborted before any token', async () => {
    const deps = createDeps({
      stream: ({ abort }) =>
        (async function* () {
          abort();
          throw abortError();
        })(),
    });
    const result = await deps.service.run(requestParams(deps));
    expect(result.answer).toBe('');
    expect(result.interrupted).toBe(true);
    expect(result.assistantMessageId).toBeNull();
    // 只有用户那一行入库，否则前端回放会多出一条空的助手气泡
    expect(deps.messages.insert).toHaveBeenCalledTimes(1);
    expect(deps.conversations.touch).not.toHaveBeenCalled();
    // 本用例没断言的两件事（有意留给其它用例）：这条分支仍会把已检索到的 sources 带回去
    //（result.sources 非空），且 chat:meta 在此之前已经推过一次——协议顺序由第三条用例钉
  });

  // 回归点：模型只吐空白也算「没有回答」，不落库（chat.service.ts#run 的 trim 判空）。
  // 防的是「历史里出现一条只有空格的助手消息」——它会占住一轮问答，回放时看着像答过
  it('does not persist a whitespace-only answer', async () => {
    const deps = createDeps({ stream: () => tokens('  ', '  ') });
    const result = await deps.service.run(requestParams(deps));
    expect(result.answer).toBe('');
    expect(result.assistantMessageId).toBeNull();
    expect(deps.messages.insert).toHaveBeenCalledTimes(1);
    expect(deps.conversations.touch).not.toHaveBeenCalled();
    // 断言只到「不落库」为止：这两个空白增量其实已经通过 onDelta 推给前端了
    //（chat.service.ts#run 的生成循环每段都推，ChatModelService 只滤空串、'  ' 是真值），
    // 本用例没有为此加断言，属已知覆盖面而非疏漏的被测行为
  });

  /**
   * 回归用例（评审 Important 1）：中断落在检索/嵌入阶段时，run() 必须和生成阶段一样
   * 以 interrupted 收尾，而不是把异常抛出 run()。
   * 为什么这条会演变成前端故障：抛出后 realtime.gateway.ts 的 catch 看到 signal.aborted
   * 就既不发 chat:error 也不发 chat:done，而 ChatPage 只在「收到 cancelled=true 的 done」
   * 时才退出流式态 ⇒ 气泡永远转圈。
   */
  it('returns interrupted instead of throwing when retrieval is aborted', async () => {
    const deps = createDeps({
      // 真实链路是 EmbeddingsService.raceWithAbort 先 reject：signal 已 abort、错误名 AbortError
      retrieve: ({ abort }) =>
        (async () => {
          abort();
          throw abortError();
        })(),
    });
    const onMeta = jest.fn();
    const onDelta = jest.fn();

    const result = await deps.service.run({
      ...requestParams(deps),
      onMeta,
      onDelta,
    });

    // 返回值直接是网关 chat:done 的字段来源：cancelled=true + assistantMessageId=null
    expect(result).toEqual({
      conversationId: 'c1',
      assistantMessageId: null,
      answer: '',
      sources: [],
      interrupted: true,
    });
    // 检索没出结果 ⇒ 引用与生成都不会发生（不能拿半成品资料去烧一次模型调用）
    expect(onMeta).not.toHaveBeenCalled();
    expect(onDelta).not.toHaveBeenCalled();
    expect(deps.chatModel.stream).not.toHaveBeenCalled();
    // 只有用户那一行入库；半条回答都没有，谈不上落库，touch 也不该动
    expect(deps.messages.insert).toHaveBeenCalledTimes(1);
    expect(deps.messages.insert).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'user' }),
    );
    expect(deps.conversations.touch).not.toHaveBeenCalled();
  });

  /**
   * 与上一条互为反面：检索阶段**不是**取消的失败必须照旧往上传，
   * 否则这个新 catch 会把 LlmError/数据库故障也吞成「用户主动停止」，网关就不再报 chat:error。
   */
  it('still propagates a non-abort retrieval failure so the gateway reports an error', async () => {
    const boom = new Error('嵌入返回维度不正确');
    boom.name = 'LlmError';
    const deps = createDeps({ retrieve: () => Promise.reject(boom) });

    await expect(deps.service.run(requestParams(deps))).rejects.toBe(boom);
    expect(deps.chatModel.stream).not.toHaveBeenCalled();
    expect(deps.messages.insert).toHaveBeenCalledTimes(1);
    expect(deps.conversations.touch).not.toHaveBeenCalled();
  });

  /**
   * 钉住「停止生成」的生成侧通道（评审 Important 2）：与 kb.retriever.spec.ts 钉检索侧同一手法。
   * 少传第二个实参不会改变任何既有断言（假 stream 不读 signal），所以必须专门断言，
   * 否则 chat.service.ts 里那个实参被删掉后，测试仍全绿而真实 HTTP 请求再也掐不断。
   */
  it('passes the same AbortSignal object to ChatModelService.stream', async () => {
    const deps = createDeps({ stream: () => tokens('好') });
    await deps.service.run(requestParams(deps));
    // toBe（不是 toEqual）：必须是同一个 signal 实例，换一个/复制一个就掐不断这次 HTTP；
    // 与 kb.retriever.spec.ts 钉检索侧第 4 个实参用的是同一手法
    expect(deps.chatModel.stream.mock.calls[0][1]).toBe(deps.controller.signal);
    expect(deps.chatModel.stream).toHaveBeenCalledWith(
      expect.any(Array),
      deps.controller.signal,
    );
  });
});
