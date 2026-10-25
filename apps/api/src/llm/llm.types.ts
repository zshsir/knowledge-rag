/**
 * 模型层的消息形状：一条对话消息 = 角色 + 纯文本内容。
 * 职责：作为「我们这一侧」的统一消息类型，把 provider 细节挡在门外
 *      （OpenAI 的 message 用 { role, content }，LangChain 用 BaseMessage，两者都由
 *      llm.module.ts 的适配器与 chat/rag-prompt.ts 负责转换）。
 * 不做什么：不带 id / 时间戳 / 引用来源（那些属于落库形状，见 messages.repository.ts），
 *      不带多模态 content（数组形式的 content parts），也没有 tool/function call 字段。
 * 消费方：llm.tokens.ts 的 ChatModelProvider 入参、llm/chat-model.service.ts 的 stream、
 *      chat/rag-prompt.ts 的 buildRagMessages（既是入参也是返回类型）、
 *      database/repositories/messages.repository.ts 的 recent（取最近若干条当上下文）。
 * 三个角色的实际来源：system 与 user 由 buildRagMessages 产出，assistant 来自历史；
 *      落库这一侧只写 user/assistant 两种，所以 recent 的 SQL 行类型也只声明这两种。
 */
export interface ChatMessage {
  /**
   * 角色字面量联合，取值范围就是 provider 认得的那三个。
   * rag-prompt.ts 的 toRole 负责从 LangChain 的消息类型映射回来：
   * 'system'→system、'ai'→assistant、其余一律兜底成 'user'。
   */
  role: 'system' | 'user' | 'assistant';
  /** 消息正文，纯字符串；流式生成时调用方自己累加增量，本类型不表达「半个 token」 */
  content: string;
}
