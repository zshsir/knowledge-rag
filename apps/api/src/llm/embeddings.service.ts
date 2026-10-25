/**
 * 嵌入服务：把文本批量转成向量。
 * 职责：分批调用 provider + 校验返回数量与维度 + 把 AbortSignal 的中断收敛成「调用方立刻失败」；
 *      不做检索、不写库。
 * 边界：真正的模型客户端由 LlmModule 的工厂提供（注入 token：EMBEDDINGS_PROVIDER），
 *      本服务只面向该接口，因此测试可以用假 provider 覆盖，不会打到真实 API。
 */
import { Inject, Injectable } from '@nestjs/common';
import { AppConfigService } from '../config/config.service';
import { LlmError } from './llm.errors';
import { EMBEDDINGS_PROVIDER, EmbeddingsProvider } from './llm.tokens';

/** 单次请求最大条数：保守的自设批次（SDK 默认 batchSize 是 512，大得多） */
const EMBED_BATCH_SIZE = 16;

/**
 * 造一个 AbortError 形状的失败原因（name = 'AbortError'）。
 * 为什么自己造而不用 @langchain/core 的 getAbortSignalError：它返回 `new Error("Aborted")`、
 * name 是 'Error'（node_modules/@langchain/core/dist/utils/signal.js:31-35），带上自定义
 * signal.reason 时还会原样抛出任意值；而本仓库判定「这是取消不是故障」看的是
 * error.name === 'AbortError' 或 signal.aborted（两处判据合在 ChatService.run 的 isAbort 里，
 * 检索阶段与生成阶段的 catch 都用它；网关的 catch 只看 signal.aborted，用来决定
 * 「不发 chat:error、不记 warn」）。
 * 取标准名字后，异常在链路上任意一层被接住都能认出是中断：检索阶段接住的那一层是
 * ChatService（它把取消收敛成 interrupted:true 的返回值，于是网关仍能推 chat:done），
 * 网关那层的 signal.aborted 判断只兜「取消之后收尾又出错」的残余情况。
 */
function abortError(): Error {
  const error = new Error('Embedding 请求已中断');
  error.name = 'AbortError';
  return error;
}

/**
 * 让「等 provider 返回」这件事和 signal 竞争一次，返回原结果或 AbortError。
 * 步骤：
 * 1. 没有 signal 时原样返回，行为与加这层之前完全一致（入库流程就不传，见 ingestion.service.ts:103）
 * 2. 注册一次性 abort 监听：signal 一触发就 reject，调用方当场解除阻塞
 * 3. 无论 provider 后来成功还是失败都摘掉监听，避免复用的长连接上监听器越堆越多
 * 重要边界（不要误读成「能取消请求」）：OpenAIEmbeddings 1.7 的 embedDocuments 只收 texts、
 * 会忽略我们传的 signal，所以这里保证的只是**调用方不再等待**；底层 HTTP 工作仍在继续，
 * 最多还会走完 SDK 内部的 3 次重试与 60s 超时，只是它最终的结果没人用了（不写库、不返回）。
 */
async function raceWithAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    const detach = () => signal.removeEventListener('abort', onAbort);
    promise.then(
      (value) => {
        detach();
        resolve(value);
      },
      (error) => {
        detach();
        reject(error);
      },
    );
  });
}

/** 嵌入服务：分批调用 provider 并校验结果，供入库流程把文本转成向量 */
@Injectable()
export class EmbeddingsService {
  constructor(
    @Inject(EMBEDDINGS_PROVIDER) private readonly provider: EmbeddingsProvider,
    private readonly config: AppConfigService,
  ) {}

  /**
   * 批量嵌入。
   * 步骤：
   * 1. 按 16 条一批切分输入，逐批调用 provider（一次塞太多会被上游拒或超时）
   * 2. 每批派发前先查 signal 是否已中断：已中断就立刻抛 AbortError，连这一批都不发出去
   *    （多批时后面的批次同理，不会继续白烧配额）
   * 3. 等结果时把 provider 调用和 signal 竞争一次，调用方最迟在 abort 的瞬间就能拿到失败
   * 4. 校验每批返回条数必须等于请求条数，否则顺序会错位（片段与向量对不上是静默错误，必须炸）
   * 5. 校验维度等于配置（默认 1024），维度不符写库时才会报错，那时文档已经失败一半
   * 关于 signal：provider 侧（OpenAIEmbeddings 1.7）忽略它，真正生效的是步骤 2/3 这两层外套；
   * 中止后调用方立刻解除阻塞，但已在飞的 HTTP 会继续跑完（含 SDK 最多 3 次重试、单次 60s 超时），
   * 只是结果不再被使用。
   */
  async embed(inputs: string[], signal?: AbortSignal): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let i = 0; i < inputs.length; i += EMBED_BATCH_SIZE) {
      // 步骤 1：切出一批并串行请求，批次顺序即结果顺序
      const batch = inputs.slice(i, i + EMBED_BATCH_SIZE);
      // 步骤 2：派发前的中断闸门（放在调用之前，才能做到「一个请求都不发」）
      if (signal?.aborted) {
        throw abortError();
      }
      // 步骤 3：与 signal 竞争，provider 忽略 signal 也不会把调用方挂住
      const result = await raceWithAbort(
        this.provider.embedDocuments(batch, { signal }),
        signal,
      );
      // 步骤 4：条数对不上就立即失败，避免向量与片段错位
      if (result.length !== batch.length) {
        throw new LlmError('Embedding 返回数量不正确');
      }
      for (const vector of result) {
        // 步骤 5：维度与配置不符的向量写进 vector(1024) 列会在 INSERT 时才报错，这里提前拦下
        if (vector.length !== this.config.embedding.dimensions) {
          throw new LlmError(
            `Embedding 维度不正确，期望 ${this.config.embedding.dimensions}`,
          );
        }
        vectors.push(vector);
      }
    }
    return vectors;
  }
}
