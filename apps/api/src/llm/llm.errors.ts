/**
 * 模型层自己的错误类型：只用来标记「调用大模型这一步出了问题」。
 * 职责：提供一个可判别的错误名（name = 'LlmError'），把 provider 返回不合规这类
 *      「我们自己的校验失败」和 SDK 抛上来的原始 HTTP 异常区分开。
 * 不做什么：不是 HttpException，因此不带任何 HTTP 语义；不分类错误原因、不携带重试标记。
 * 现役抛出点只有两处，都在 EmbeddingsService 里且都不传 status：
 *      返回条数与请求条数不符、向量维度与 EMBEDDING_DIMENSIONS 不符（llm/embeddings.service.ts）。
 * 关于 status：全仓库没有任何代码读它（`instanceof LlmError` 零命中，也没有按 status 分支的地方），
 *      AllExceptionsFilter 取状态码只认 `exception instanceof HttpException`（见该文件步骤 2），
 *      所以即便有人传了 status 也不会生效——LlmError 逃到 HTTP 层就是 500「服务器内部错误」。
 *      这条留在这里是为了说明「别指望它能改状态码」，不是建议删除字段。
 * 传播后果（按调用方分两条路，都是已核对的行为）：
 * - 问答链路：RetrievalService 让 embed 的异常原样上抛，ChatService.run 用 isAbort 判「是不是取消」，
 *   判据是 `signal.aborted || error.name === 'AbortError'`（chat.service.ts 的 isAbort）。
 *   LlmError 的 name 不是 AbortError，所以在用户没点停止时它算故障 → 继续上抛 → WebSocket 侧发 chat:error；
 *   但若此刻 signal 已经 aborted，同一异常会被归成「取消」，走 interrupted:true 的返回值。
 * - 入库链路：IngestionService 的 catch 只对 BadRequestException 收敛成「永久失败不重试」，
 *   LlmError 不是它 → 重新抛给 pg-boss → 该次尝试判失败并按队列配置重试。
 */
export class LlmError extends Error {
  /**
   * 步骤：
   * 1. super(message)：交给原生 Error 记录 message 与堆栈
   * 2. 盖 name = 'LlmError'：让日志和错误串里一眼认出这是模型层的校验失败
   *    （不是 HTTP 错误的堆栈噪音）。注意现状没有任何代码按 name === 'LlmError' 分支，
   *    真正的判别靠类型本身：单测用 `rejects.toThrow(LlmError)` 断言（embeddings.service.spec.ts）
   * 3. status 走构造参数属性赋值（readonly，实例上直接可见）；现状无人读，见文件头
   */
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}
