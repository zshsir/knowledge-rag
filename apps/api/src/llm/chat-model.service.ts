/**
 * 对话模型服务：只负责「把消息喂给模型，把 token 流吐出来」。
 * 边界：不拼提示词（在 chat/rag-prompt.ts）、不落库（在 chat/chat.service.ts）、
 *      不决定中断后怎么保存（由调用方累加增量，天然支持「停止生成保留半条」）。
 */
import { Inject, Injectable } from '@nestjs/common';
import { ChatMessage } from './llm.types';
import { CHAT_MODEL_PROVIDER, ChatModelProvider } from './llm.tokens';

/**
 * 流式请求超时：5 分钟。它作为单次调用的 options.timeout 传进 streamEvents，
 * 而 @langchain/core 会把它变成**端到端**的兜底（不是摆设，机制链条如下，改依赖版本后要复验）：
 * 1. ensureConfig（core dist/runnables/config.js:105-120）把 timeout 换成 AbortSignal.timeout(ms)，
 *    并用 AbortSignal.any 与调用方传进来的 signal 合成一个信号
 * 2. runnables/base.js:128-154 只是把 timeout 这个【键】从 callOptions 里删掉，
 *    随后 _separateRunnableConfigFromCallOptionsCompat（language_models/chat_models.js:71-75）
 *    会把 runnableConfig.signal——也就是那个合成信号——重新挂回 callOptions.signal
 * 3. _streamEventsV2（runnables/base.js:404-406）带着它进流式分支 _streamChatModelEvents，
 *    @langchain/openai 的 dist/chat_models/completions.js:171 用 completionWithRetry(params, options)
 *    把整份 options（含合成 signal）交给 SDK，并用 abortableStream 包住响应流（:173-179）；
 *    同文件 :116 的 `signal: options?.signal` 属于非流式分支，不在这条链路上
 * 实测（本文件 spec 的第二组用例，服务用真实 ChatOpenAI 打一个只接受不作答的本地服务）：
 * timeout=500 时抛出落在该用例 300–2000ms 的断言带内（具体毫秒数随机器漂移，不写死），
 * timeout=2000 时 800ms 那刻仍未落定。
 *
 * 后果要说全，别只说「超时了」：
 * - 错误的形状随环境而变：在 jest 环境里实测 name 是 'Error'（message 'Aborted'）——那是
 *   jest-environment 的产物；纯 Node 脚本复现同一条链，抛的是 name 为 'TimeoutError' 的
 *   DOMException（message "The operation was aborted due to timeout"）。两种环境的 name 都
 *   【不是】'AbortError'，所以 chat.service.ts 的 isAbort() 怎么归类与环境无关：判为故障——
 *   已生成的半条回答照常以 interrupted=true 落库，然后错误重新抛出，网关按真故障发 chat:error。
 *   超时本来就是失败，不要为了「让它看起来像取消」去放宽 isAbort（详见 docs/operations.md §11.3）
 * - 不要改成往 new ChatOpenAI({...}) 里加 timeout：工厂那份是 SDK 的单次请求超时，
 *   这里这份是整轮调用的上界，两处各设会变成两层计时；基线那种「每个请求挂一个 setTimeout」
 *   已经由上面这条链取代
 * - 本文件不做重试次数的承诺：生产工厂是 maxRetries: 1（llm.module.ts:106），
 *   而 spec 的实测用的是 maxRetries: 0，「超时会不会被当成可重试错误再打一次」不在覆盖范围内
 */
const CHAT_TIMEOUT_MS = 5 * 60_000;

@Injectable()
export class ChatModelService {
  constructor(
    @Inject(CHAT_MODEL_PROVIDER) private readonly model: ChatModelProvider,
  ) {}

  /**
   * 流式生成。
   * 步骤：
   * 1. 用 streamEvents 拿到纯文本增量流（LangChain 已替我们解析 SSE）
   * 2. 传入 signal：用户点「停止生成」时会真正掐断 HTTP 请求，不只是前端不显示
   * 3. 过滤空增量后逐个 yield，调用方负责累加保存中断内容
   */
  async *stream(
    messages: ChatMessage[],
    signal?: AbortSignal,
  ): AsyncGenerator<string> {
    // 步骤 1：发起一轮对话，返回的是适配后的纯文本增量流
    const events = await this.model.streamEvents(messages, {
      signal,
      timeout: CHAT_TIMEOUT_MS,
    });
    // 步骤 2 + 3：signal 已透传给底层请求；这里只做空增量过滤，不缓冲、不改写内容
    for await (const delta of events.text) {
      if (delta) yield delta;
    }
  }
}
