/**
 * 模型层模块。全局模块：入库 worker、对话、检索都依赖它。
 * 注意 provider 用工厂单独注册，测试可以只换 provider 而不动服务逻辑。
 * 本模块同时负责把 LangChain 真实客户端适配成 llm.tokens.ts 里的最小接口。
 * 边界：只暴露 EmbeddingsService / ChatModelService 与两个 provider token；
 *      手写 fetch + SSE 的旧 LlmService 已在 B8 连同 sse-parser 一起删除，不要再往这里加回。
 */
import { Global, Module } from '@nestjs/common';
import { isBaseMessageChunk } from '@langchain/core/messages';
import { StreamEvent } from '@langchain/core/tracers/log_stream';
import { ChatOpenAI, OpenAIEmbeddings } from '@langchain/openai';
import { AppConfigService } from '../config/config.service';
import { ChatModelService } from './chat-model.service';
import { ChatMessage } from './llm.types';
import {
  CHAT_MODEL_PROVIDER,
  ChatModelProvider,
  EMBEDDINGS_PROVIDER,
} from './llm.tokens';
import { EmbeddingsService } from './embeddings.service';

/**
 * 把 LangChain 的 StreamEvent 流收敛成纯文本增量。
 * 为什么单独导出：流式语义只在 toTextDeltas 里实现，单测要直接喂真实 StreamEvent；
 * 而构造 ChatOpenAI 需要配置、调用还会发网络请求，不适合放进单测。
 * 步骤：
 * 1. 逐个读取事件
 * 2. 只保留 on_chat_model_stream（模型增量），链/工具的开始结束事件一律丢弃
 * 3. 收窄成消息增量后取 .text（.text 声明在 BaseMessage 上，多段 content 已拼成纯文本）
 *
 * 这里刻意只判 isBaseMessageChunk、不判 isAIMessageChunk：
 * provider 在首个增量里省略 delta.role 时，LangChain 产出的是 ChatMessageChunk
 * （_getType() 为 generic），isAIMessageChunk 对它返回 false；若据此过滤，
 * 会让「模型明明产出了文本」变成空答案。
 */
export async function* toTextDeltas(
  events: AsyncIterable<StreamEvent>,
): AsyncIterable<string> {
  for await (const event of events) {
    // 步骤 2：非模型增量事件（链开始/结束、工具调用等）一律跳过
    if (event.event !== 'on_chat_model_stream') continue;
    const chunk: unknown = event.data.chunk;
    // 步骤 3：只收窄到「消息增量」即可，不限定角色，避免漏掉无 role 的 ChatMessageChunk
    if (!isBaseMessageChunk(chunk)) continue;
    yield chunk.text;
  }
}

/**
 * 把 ChatOpenAI 的事件流收敛成 ChatModelProvider 需要的纯文本流。
 * 为什么需要它：ChatOpenAI.streamEvents 要求 version: "v2"，返回的是完整事件流
 * （链/工具的开始结束事件也在其中），而对话服务只关心模型增量文本。
 * 步骤：
 * 1. 调 ChatOpenAI.streamEvents（v2 事件格式），把 signal/timeout 透传给底层 HTTP 请求
 * 2. 把事件流交给 toTextDeltas 过滤并抽取增量文本
 */
class ChatOpenAIAdapter implements ChatModelProvider {
  constructor(private readonly model: ChatOpenAI) {}

  async streamEvents(
    input: ChatMessage[],
    options?: { signal?: AbortSignal; timeout?: number },
  ): Promise<{ text: AsyncIterable<string> }> {
    // 步骤 1：ChatMessage 转成 LangChain 认识的 [role, content] 元组后再发起流式调用
    const events = this.model.streamEvents(
      input.map(
        (message) => [message.role, message.content] as [string, string],
      ),
      { version: 'v2', ...(options ?? {}) },
    );
    return { text: toTextDeltas(events) };
  }
}

@Global()
@Module({
  providers: [
    EmbeddingsService,
    ChatModelService,
    {
      provide: EMBEDDINGS_PROVIDER,
      // SiliconFlow 兼容 OpenAI 协议，因此直接复用 OpenAIEmbeddings 换 baseURL
      useFactory: (config: AppConfigService) =>
        new OpenAIEmbeddings({
          model: config.embedding.model,
          apiKey: config.llm.apiKey,
          configuration: { baseURL: config.llm.baseUrl },
          maxRetries: 3,
          timeout: 60_000,
        }),
      inject: [AppConfigService],
    },
    {
      provide: CHAT_MODEL_PROVIDER,
      // 步骤 1：同样复用 OpenAI 协议客户端，仅换 baseURL
      // 步骤 2：temperature 固定 0.2；知识库问答要稳定复述资料，不要发挥
      // 步骤 3：包一层适配器，把事件流收敛成服务需要的纯文本增量流
      useFactory: (config: AppConfigService): ChatModelProvider =>
        new ChatOpenAIAdapter(
          new ChatOpenAI({
            model: config.llm.model,
            apiKey: config.llm.apiKey,
            configuration: { baseURL: config.llm.baseUrl },
            temperature: 0.2,
            maxTokens: 1500,
            maxRetries: 1,
          }),
        ),
      inject: [AppConfigService],
    },
  ],
  exports: [
    EmbeddingsService,
    ChatModelService,
    EMBEDDINGS_PROVIDER,
    CHAT_MODEL_PROVIDER,
  ],
})
export class LlmModule {}
