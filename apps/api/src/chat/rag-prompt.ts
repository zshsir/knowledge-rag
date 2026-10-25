/**
 * RAG 提示编排：把「检索到的片段 + 历史 + 当前问题」组装成模型消息。
 * 边界：不检索（检索在 KbRetriever/RetrievalService）、不调模型（在 ChatModelService），
 *      只负责提示词，方便单独回归引用格式；唯一调用方是 chat.service.ts。
 * 为什么用 LangChain ChatPromptTemplate 而不是手拼数组：模板可复用、
 *      历史段走 MessagesPlaceholder 才能保住 user/assistant 的角色边界，
 *      变量漏传时由框架报错而不是静默拼出错误提示。
 *      （报错形状按 @langchain/core 1.3 的 JS 实现：抛的是普通 Error，带
 *       `lc_error_code === 'INVALID_PROMPT_INPUT'`，实测见 formatMessages 少传 history；
 *       Python 版的 InvalidPromptException / InputFormatError 只是文档里的同名概念，
 *       JS 包里既没有这两个类名，错误的 name 也不是它们。）
 */
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { ChatPromptTemplate, MessagesPlaceholder } from '@langchain/core/prompts';
import { ChatMessage } from '../llm/llm.types';
import { Source } from './sources';

const SYSTEM_PROMPT = `你是知识库问答助手。只能依据提供的资料回答，不得编造资料中没有的信息。
回答时在相关句子后标注来源编号，例如 [1]、[2]。
如果资料不足以回答，请明确说明“知识库中没有找到足够的信息”，并给出可能的下一步建议。
使用与用户问题相同的语言回答，保持简洁、准确。`;

/** 只保留最近 6 条历史，再多会挤占资料上下文并抬高延迟 */
const HISTORY_LIMIT = 6;

/**
 * 消息模板：模块级只构造一次，供每次请求复用（ChatPromptTemplate 自身无请求状态，
 * 变量都在 formatMessages 的入参里，因此这样共享不会把上一个问题的资料带进下一次）。
 * 三段的分工：
 * - system：固定指令 + {context}。{context} 由 formatNumberedContext 预先拼好，
 *   这样用户内容/资料原文永远不会被当成模板变量解析（资料里出现 { } 也不会炸）。
 * - MessagesPlaceholder('history')：整段历史消息，保持角色不退化。
 * - human：当前问题。
 */
const prompt = ChatPromptTemplate.fromMessages([
  ['system', `${SYSTEM_PROMPT}\n\n参考资料：\n{context}`],
  new MessagesPlaceholder('history'),
  ['human', '{question}'],
]);

/**
 * 拼接带编号的资料块。
 * 步骤：
 * 1. 每条资料一行头：[编号] 文件：xxx（片段 n），后换行接正文
 * 2. 编号直接用检索阶段分配好的 index，保证与前端引用卡片一致
 * 3. 空列表返回固定提示，让模型明确「没资料」而不是瞎编
 * 输出格式与删除掉的 PromptService 逐字节一致（rag-prompt.spec.ts 里有整串相等断言）。
 */
export function formatNumberedContext(sources: Source[]): string {
  if (!sources.length) return '（没有检索到相关资料）';
  return sources
    .map(
      (source) =>
        `[${source.index}] 文件：${source.filename}（片段 ${source.chunkIndex}）\n${source.content}`,
    )
    .join('\n\n');
}

/**
 * 落库/前端的历史角色 → LangChain 消息类型。
 * assistant 必须映射成 AIMessage：映射成 HumanMessage 会让模型把历史回答当成用户说的话。
 */
function toHistoryMessage(message: ChatMessage) {
  return message.role === 'assistant'
    ? new AIMessage(message.content)
    : new HumanMessage(message.content);
}

/**
 * LangChain 消息类型 → 我们的角色字面量（provider 只认 system/user/assistant）。
 * 未知类型按 user 处理：本模板只会产出 system/human/ai 三种，兜底只为不让自定义消息
 * 把 role 变成 undefined 而污染请求体。
 */
function toRole(type: string): ChatMessage['role'] {
  if (type === 'system') return 'system';
  if (type === 'ai') return 'assistant';
  return 'user';
}

/**
 * 构造模型消息。
 * 步骤：
 * 1. 资料拼成 {context}，历史截到最后 HISTORY_LIMIT 条并转成 LangChain 消息
 * 2. 用模板渲染出 BaseMessage[]
 *    （必须是 formatMessages：@langchain/core 1.x 的 format() 走
 *     `formatPromptValue().toString()`，返回 "System: ...\nHuman: ..." 的纯字符串，
 *     拿不到消息数组也就还原不出 role）
 * 3. 转回 OpenAI 形状的 {role, content}，交给 ChatModelService.stream 直接发送
 */
export async function buildRagMessages(
  history: ChatMessage[],
  sources: Source[],
  question: string,
): Promise<ChatMessage[]> {
  const messages = await prompt.formatMessages({
    context: formatNumberedContext(sources),
    history: history.slice(-HISTORY_LIMIT).map(toHistoryMessage),
    question,
  });
  return messages.map((message) => ({
    role: toRole(message.getType()),
    // .text 已把多段 content 拼成纯文本；我们只产出文本，没有多模态分支
    content: message.text,
  }));
}
