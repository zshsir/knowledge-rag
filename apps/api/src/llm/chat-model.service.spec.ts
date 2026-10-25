/**
 * ChatModelService 的流式行为测试，两组各有各的覆盖面。
 * 边界：
 * - 第一组只用假模型验证「按序透传增量」「过滤空增量」「signal/timeout 透传」，不发任何网络请求；
 *   适配器把真实事件流收敛成增量的逻辑由 llm.adapter.spec.ts 单独覆盖
 * - 第二组用**真实** ChatOpenAI 打一个本地「只接受不回应」的 HTTP 服务，钉的是 LangChain
 *   自己那套 timeout → AbortSignal 的机制还在不在（假 provider 永远测不出这一层）
 * - 两组都不出网：真实 ChatOpenAI 只指向 127.0.0.1，用的密钥是占位串
 */
import { createServer } from 'node:http';
import { ChatOpenAI } from '@langchain/openai';
import { ChatMessage } from './llm.types';
import { ChatModelService } from './chat-model.service';
import { ChatModelProvider } from './llm.tokens';

/** 记录一次 streamEvents 调用的实参，供断言透传 */
interface CallArgs {
  input: ChatMessage[];
  options?: { signal?: AbortSignal; timeout?: number };
}

/**
 * 造一个只实现 streamEvents 的假模型：每轮按顺序吐出预置 token，避免真实网络请求。
 * 同时把调用实参记进 calls，用来验证服务确实把 signal/timeout 传了下来。
 */
function fakeModel(tokens: string[], calls: CallArgs[] = []): ChatModelProvider {
  return {
    streamEvents: async (input, options) => {
      calls.push({ input, options });
      return {
        text: (async function* () {
          for (const token of tokens) yield token;
        })(),
      };
    },
  };
}

/** 收干异步生成器，便于对整段输出做一次性断言 */
async function collect(generator: AsyncGenerator<string>) {
  const out: string[] = [];
  for await (const chunk of generator) out.push(chunk);
  return out;
}

describe('ChatModelService', () => {
  // 回归点：增量的顺序与内容不许被服务层改动（不缓冲、不改写）——前端逐字渲染与
  // 「半条也落库」的中断语义都依赖这个透传性质
  it('按顺序透传模型产出的增量 token', async () => {
    const service = new ChatModelService(fakeModel(['你', '好']));
    const result = await collect(
      service.stream([{ role: 'user', content: 'hi' }]),
    );
    expect(result).toEqual(['你', '好']);
  });

  // 回归点：空增量必须被吃掉（chat-model.service.ts#stream 的 `if (delta) yield delta`）。放到 WebSocket 上就是
  // 一串内容为空的 chat:delta 帧，前端会收到无意义的重绘与空片段
  it('跳过空增量，避免前端收到无意义 delta', async () => {
    const service = new ChatModelService(fakeModel(['a', '', 'b']));
    const result = await collect(
      service.stream([{ role: 'user', content: 'hi' }]),
    );
    expect(result).toEqual(['a', 'b']);
  });

  // 回归点：B7 评审的 Important——当时没有任何用例钉住 signal 透传，把 streamEvents 的
  // 第二个实参整个删掉，全量单测仍全绿，而「停止生成」会静默失效。
  // timeout 也一起钉住：它来自 CHAT_TIMEOUT_MS（chat-model.service.ts 顶部那个常量），漏传就走 SDK 默认值
  it('把 signal 与 5 分钟 timeout 透传给 provider', async () => {
    const calls: CallArgs[] = [];
    const controller = new AbortController();
    const service = new ChatModelService(fakeModel(['x'], calls));
    await collect(service.stream([{ role: 'user', content: 'hi' }], controller.signal));
    // 已知弱点：toEqual 是深比较，只能证明「signal 被透传」，证明不了传的是原对象而非包装；
    // 要严格钉引用得用 toBe（遗留项，未在此改动断言）
    expect(calls).toEqual([
      {
        input: [{ role: 'user', content: 'hi' }],
        options: { signal: controller.signal, timeout: 5 * 60_000 },
      },
    ]);
  });
});

/**
 * 上面那组只能证明「timeout 被传进了假 provider」，证明不了 LangChain 真的消费它。
 * 这一组换成**真实** ChatOpenAI + 一个「接受连接但永远不 end()」的本地 HTTP 服务，
 * 把「streamEvents({ timeout }) 是端到端兜底」这件事钉住（设计文档 §5.1「5 分钟总超时保留」）：
 * @langchain/core 的 ensureConfig 会把 options.timeout 变成 AbortSignal.timeout(ms)，
 * 与调用方的 signal 用 AbortSignal.any 合成一个，再经 _separateRunnableConfigFromCallOptionsCompat
 * 重新挂回 callOptions.signal，最后由 @langchain/openai 的流式分支 _streamChatModelEvents
 * 用 completionWithRetry(params, options) 把整份 options 交给 SDK 并用 abortableStream 包流
 * （dist/runnables/config.js:105-120、language_models/chat_models.js:71-75、
 * @langchain/openai/dist/chat_models/completions.js:171、:173-179；同文件 :116 那份
 * signal: options?.signal 属于非流式分支）。
 * 如果哪天 core 不再做那次 compat 重新挂载，这条用例会红，而不是让「超时已失效」悄悄上线。
 */
describe('ChatModelService 的超时机制（真实 ChatOpenAI）', () => {
  it('streamEvents({ timeout }) 到点即掐断请求并抛出错误', async () => {
    // 步骤 1：起一个只接受连接、绝不回应的本地服务（127.0.0.1 随机端口）
    const server = createServer(() => {
      // 刻意不调用 res.end()/res.write()：请求会一直挂着，直到客户端自己 abort
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve()),
    );
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    try {
      // 步骤 2：真实 ChatOpenAI 指向它；apiKey 是占位串（不发往任何公网地址），
      // maxRetries 关掉，避免超时被重试成 N 倍时长
      const model = new ChatOpenAI({
        model: 'qoder-test-model',
        apiKey: 'test-key-not-a-secret',
        configuration: { baseURL: `http://127.0.0.1:${port}/v1` },
        maxRetries: 0,
      });
      // 步骤 3：像 chat-model.service.ts 那样把 timeout 作为单次调用 options 传进去
      const events = await model.streamEvents(
        [['human', '你好']],
        { version: 'v2', timeout: 500 },
      );

      // 步骤 4：消费事件流，断言它 reject 且耗时贴着 500ms 而不是 5 分钟或无限挂着
      const startedAt = Date.now();
      const consume = (async () => {
        for await (const _event of events) {
          // 什么都不做：这个流本来就不会来任何增量
        }
      })();
      const caught = await consume.catch((error: unknown) => error);
      const elapsed = Date.now() - startedAt;

      // 步骤 5：钉住「确实抛了、抛的是哪一种、什么时候抛的」三件事
      // a) 确实抛出：这个流本来不该有任何增量，能结束只能是因为超时把请求掐了
      expect(caught).toBeInstanceOf(Error);
      // b) 错误的 name：在 jest 环境里实测是 'Error'（message 'Aborted'）——这个形状是
      //    jest-environment 的产物；纯 Node 脚本复现同一条链，抛的是 name 为 'TimeoutError' 的
      //    DOMException（message "The operation was aborted due to timeout"）。归类真正依赖的是
      //    与环境无关的那半句：两种环境的 name 都【不是】'AbortError'，所以 chat.service.ts 的
      //    isAbort() 判它为故障而不是「用户取消」：半条回答照样落库（interrupted=true）后重新抛出，
      //    网关发 chat:error。见 docs/operations.md §11.3 最后一条。
      //    下面这条断言与 jest 环境的形状绑定：若哪天 core / openai / Node / jest 换了这里的
      //    错误类型（例如变成 TimeoutError 或 AbortError），它会红——那时按新形状重核上面那半句
      //    「name 不是 AbortError」是否仍成立，并重新走一遍归类，这才是本用例要钉住的东西；
      //    不要为了迁就新形状去放宽 isAbort
      expect((caught as Error).name).toBe('Error');
      // c) 什么时候抛的：下界挡住「连不上立刻失败」这种假通过（本机端口没监听时
      //    几十毫秒就会 reject），上界挡住 timeout 失效后退化到 SDK 默认超时的情况
      expect(elapsed).toBeGreaterThanOrEqual(300);
      expect(elapsed).toBeLessThan(2000);
    } finally {
      // 步骤 6：先把还挂着的客户端连接掐掉再关服务，否则 close() 要等它们自己结束，
      // 给 jest 留一个开放句柄（本套已有「Jest did not exit」遗留问题，不能再加一个）
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  /**
   * 反证（防止上面那条变成空跑）：把 timeout 设成 2000ms，800ms 那一刻流【还没有】结束。
   * 没有这条，「500ms 附近 reject」有可能被别的环境因素凑出来（例如服务直接断连），
   * 那时上面那条其实什么也没钉住。本条只观察「早于 timeout 时没有落定」，
   * 不等满 2 秒，所以整套仍然只有 ~1 秒量级。
   */
  it('timeout 之前不会提前落定（反证上面那条不是空跑）', async () => {
    const server = createServer(() => {
      // 同样只接受连接、不作答
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve()),
    );
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      const model = new ChatOpenAI({
        model: 'qoder-test-model',
        apiKey: 'test-key-not-a-secret',
        configuration: { baseURL: `http://127.0.0.1:${port}/v1` },
        maxRetries: 0,
      });
      const events = await model.streamEvents([['human', '你好']], {
        version: 'v2',
        timeout: 2000,
      });
      // consume 自带 catch：即使它在本用例结束之后才 reject，也不会变成 unhandled rejection
      const consume = (async () => {
        for await (const _event of events) {
          // 什么都不做
        }
        return 'COMPLETED';
      })().catch(() => 'REJECTED');
      const settledEarly = await Promise.race([
        consume,
        new Promise((resolve) => setTimeout(() => resolve('PENDING'), 800)),
      ]);
      // 800ms 时既没跑完也没报错 ⇒ 上面那条 500ms 的报错确实来自 timeout 这个选项
      expect(settledEarly).toBe('PENDING');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
