/**
 * 模型层的注入 token 与最小依赖接口。
 * 边界：这里只声明「我们需要什么能力」，不关心具体是哪家模型服务，
 *      便于测试用假实现覆盖 provider，e2e 不打真实 API。
 *      对话 provider 自 B2（Task 8）起导出，服务在 Task 13 才接进 ChatService。
 */
import { ChatMessage } from './llm.types';

/** 向量嵌入 provider 的注入 token（测试里用 overrideProvider 换成假实现） */
export const EMBEDDINGS_PROVIDER = 'EMBEDDINGS_PROVIDER';

/**
 * LangChain Embeddings 的最小子集。
 * options.signal 只有 provider 自己实现时才会生效：OpenAIEmbeddings 1.7 的
 * embedDocuments(texts) 只接收一个参数，会忽略 signal；
 * 单次请求超时 60_000，另有 3 次重试（实际总耗时可能接近 4 次尝试加退避）。
 */
export interface EmbeddingsProvider {
  embedDocuments(
    texts: string[],
    options?: { signal?: AbortSignal },
  ): Promise<number[][]>;
}

/** 对话模型 provider 的注入 token（测试里换成假模型，不打真实 API） */
export const CHAT_MODEL_PROVIDER = 'CHAT_MODEL_PROVIDER';

/**
 * 对话模型里我们实际用到的最小能力。
 * 为什么不是 ChatOpenAI 本身：真实的 streamEvents 要求 version: "v2"，
 * 返回的是 LangChain 事件流（含链/工具的开始结束事件），不是纯文本增量；
 * llm.module.ts 用一个适配器把它收敛成 { text }，测试便可以只实现这一个方法。
 * 步骤：一次调用 = 发起一轮对话，text 按模型产出顺序吐出增量 token。
 * input 收紧为 ChatMessage[]：适配器已存在，不再需要为结构化兼容留宽类型。
 */
export interface ChatModelProvider {
  streamEvents(
    input: ChatMessage[],
    options?: { signal?: AbortSignal; timeout?: number },
  ): Promise<{ text: AsyncIterable<string> }>;
}
