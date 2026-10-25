/**
 * 对话编排服务：会话 CRUD + 一轮问答的流程装配（鉴权 → 检索 → 引用 → 生成 → 落库）。
 * 边界：召回的具体 SQL 在 RetrievalService/KbRetriever，提示词文本在 rag-prompt.ts，
 *      模型 HTTP 与 SSE 解析在 ChatModelService；本文件只决定「先后顺序、推给前端什么、
 *      什么情况下落库」。调用方是 realtime.gateway.ts（WebSocket）与 chat.controller.ts（会话 CRUD）。
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { AuthUser } from '../common/types';
import { ConversationsRepository } from '../database/repositories/conversations.repository';
import { MessagesRepository } from '../database/repositories/messages.repository';
import { KbAccessService } from '../knowledge-bases/kb-access.service';
import { ChatModelService } from '../llm/chat-model.service';
import { buildRagMessages } from './rag-prompt';
import { KbRetriever } from './kb.retriever';
import { RetrievalService } from './retrieval.service';
import { Source, toSource } from './sources';

export const NO_RESULTS_ANSWER =
  '知识库中没有找到足够的信息，请尝试换一种问法或先上传相关资料。';

export interface ChatRunParams {
  user: AuthUser;
  orgId: string;
  kbId: string;
  conversationId?: string;
  question: string;
  signal: AbortSignal;
  onMeta: (meta: {
    conversationId: string;
    userMessageId: string;
    sources: Source[];
  }) => void;
  onDelta: (text: string) => void;
}

export interface ChatResult {
  conversationId: string;
  assistantMessageId: string | null;
  answer: string;
  sources: Source[];
  interrupted: boolean;
}

/**
 * 判定一次失败是「用户取消」还是「真故障」：signal 已 abort，或错误名是 AbortError。
 * 检索阶段与生成阶段必须用同一个判据（两处 catch 都调它），否则同样是点「停止生成」，
 * 落在嵌入期间就会绕过本服务的中断分类：异常抛到 realtime.gateway.ts 的 catch，
 * 那里现在会补一条 chat:done{assistantMessageId:null, cancelled:true}（步骤 10b）把流关掉，
 * 但那是最差的收尾——引用没送出去、会话 id 只能退回请求里带的那个（新对话时是空串），
 * 前端等于「什么都没答」。在本服务收敛成 interrupted:true 才有正常的 done。
 * 判据用 name 而不是 instanceof：EmbeddingsService 造的是 name='AbortError' 的普通 Error
 * （@langchain/core 的 getAbortSignalError 给的 name 是 'Error'，认不出来）。
 * 为什么不必再认 openai SDK 的 APIUserAbortError（B8 实测，别再往这里加）：
 * 1. 打真实中断路径拿不到它。对 @langchain/openai 1.7 / @langchain/core 1.3 的
 *    ChatOpenAI.streamEvents({signal}) 实测三条路径——已 abort 的 signal 才传入、请求在飞时 abort、
 *    流已开始吐字后 abort——抛上来的都是 Node 的 DOMException（name='AbortError'，
 *    message='This operation was aborted'），不是 APIUserAbortError，现有判据已经覆盖。
 * 2. 即使真出现也认不出来：SDK 7.43 的 APIUserAbortError 实例上 name 是 'Error'
 *    （类名没被写进实例），只有 instanceof 能判，而那要求对话层 import SDK 的异常类，不值得。
 * 3. 检索侧根本走不到 SDK 的中断异常：OpenAIEmbeddings 会忽略我们传的 signal
 *    （实测 abort 后 embedDocuments 的 promise 仍在 pending），中断错误一律由
 *    EmbeddingsService 自己造（name='AbortError'）。
 * 4. 唯一能造出「APIUserAbortError 但 signal 没 abort」的是 SDK 内部超时自己 abort，
 *    那是故障不是用户取消：按上面的语义应继续走 chat:error，所以「不放宽」才是对的。
 */
function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error as Error)?.name === 'AbortError';
}

@Injectable()
export class ChatService {
  constructor(
    private readonly conversations: ConversationsRepository,
    private readonly messages: MessagesRepository,
    private readonly retrieval: RetrievalService,
    private readonly chatModel: ChatModelService,
    private readonly kbAccess: KbAccessService,
  ) {}

  async listConversations(userId: string, orgId: string, kbId: string) {
    await this.kbAccess.require(orgId, kbId, userId, 'viewer');
    return this.conversations.list(orgId, kbId, userId);
  }

  async createConversation(
    userId: string,
    orgId: string,
    kbId: string,
    title?: string,
  ) {
    await this.kbAccess.require(orgId, kbId, userId, 'viewer');
    return this.conversations.create({
      orgId,
      kbId,
      userId,
      title: title?.trim() || '新对话',
    });
  }

  async listMessages(userId: string, orgId: string, conversationId: string) {
    const conversation = await this.conversations.findOwnedById(
      orgId,
      userId,
      conversationId,
    );
    if (!conversation) throw new NotFoundException('会话不存在');
    await this.kbAccess.require(orgId, conversation.kbId, userId, 'viewer');
    return this.messages.list(conversationId);
  }

  async deleteConversation(
    userId: string,
    orgId: string,
    conversationId: string,
  ) {
    const conversation = await this.conversations.findOwnedById(
      orgId,
      userId,
      conversationId,
    );
    if (!conversation) throw new NotFoundException('会话不存在');
    await this.kbAccess.require(orgId, conversation.kbId, userId, 'viewer');
    await this.conversations.delete(orgId, userId, conversationId);
    return { ok: true };
  }

  /**
   * 一轮问答的完整编排：鉴权 → 会话 → 检索 → 推引用 → 生成 → 落库。
   * 步骤见方法内注释；返回结构（含 assistantMessageId 可能为 null、interrupted）
   * 是 WebSocket 层 chat:done 事件的直接来源，前端据此定位气泡与「已中断」标记。
   * 中断的归类覆盖检索与生成两段：这两段里因 abort 失败的都收敛成 interrupted:true 的正常返回，
   * 而不是从本方法抛出（只有真故障才抛）——抛出后网关只能补一条 assistantMessageId 为 null 的
   * chat:done（realtime.gateway.ts 步骤 10b），引用和真实会话 id 都带不出去。
   */
  async run(params: ChatRunParams): Promise<ChatResult> {
    // 步骤 1：权限现判（viewer 即可问；会话/消息都归这个租户这个知识库）
    await this.kbAccess.require(
      params.orgId,
      params.kbId,
      params.user.id,
      'viewer',
    );

    // 步骤 2：定位会话，没有 id 就用问题前 30 字建一条（标题由前端展示，可后续改名）
    let conversation = params.conversationId
      ? await this.conversations.findOwned(
          params.orgId,
          params.kbId,
          params.user.id,
          params.conversationId,
        )
      : null;
    if (params.conversationId && !conversation) {
      throw new NotFoundException('会话不存在');
    }
    if (!conversation) {
      conversation = await this.conversations.create({
        orgId: params.orgId,
        kbId: params.kbId,
        userId: params.user.id,
        title: params.question.slice(0, 30),
      });
    }

    // 历史窗口固定 6 条：再多会挤占资料上下文（提示链里还有一道同样的截断）
    const history = await this.messages.recent(conversation.id, 6);
    const userMessage = await this.messages.insert({
      conversationId: conversation.id,
      role: 'user',
      content: params.question,
    });

    // 步骤 3：LangChain 检索器召回片段（只检索一次，结果同时用于引用展示与提示词）
    // 每个请求 new 一个实例：orgId/kbId/signal 绑在实例上，注册成单例会把上一个请求的租户带过来
    const retriever = new KbRetriever(this.retrieval, {
      orgId: params.orgId,
      kbId: params.kbId,
      signal: params.signal,
    });
    // 检索期间点「停止生成」也要走本服务的中断分类（评审 Important 1 的修复点）：
    // 嵌入阶段的 AbortError 一旦从这里抛出 run()，网关就只剩步骤 10b 那条兜底 done——
    // 前端能退出流式态，但引用没送出去、会话 id 也回不来，等于白问一次。
    // 此刻还没有任何生成内容，所以按「一段都没吐」的一致性收尾：不落助手行、不 touch、
    // 引用还没算出来因此 sources 为空、也不推 chat:meta（没有 delta 可跟，meta-before-delta 不受影响）。
    // 非取消的检索失败（LlmError/数据库故障）照旧上抛，由网关发 chat:error。
    let sources: Source[];
    try {
      const documents = await retriever.invoke(params.question);
      sources = documents.map(toSource);
    } catch (error) {
      if (!isAbort(error, params.signal)) throw error;
      return {
        conversationId: conversation.id,
        assistantMessageId: null,
        answer: '',
        sources: [],
        interrupted: true,
      };
    }

    // 步骤 4：先把引用推给前端（必须在第一个 delta 之前，否则引用卡片会掉到回答后面）
    params.onMeta({
      conversationId: conversation.id,
      userMessageId: userMessage.id,
      sources,
    });

    // 步骤 4 分支：没召回任何资料 → 直接回固定话术，不消耗模型调用
    if (!sources.length) {
      params.onDelta(NO_RESULTS_ANSWER);
      const assistant = await this.messages.insert({
        conversationId: conversation.id,
        role: 'assistant',
        content: NO_RESULTS_ANSWER,
        sources: [],
      });
      await this.conversations.touch(conversation.id);
      return {
        conversationId: conversation.id,
        assistantMessageId: assistant.id,
        answer: NO_RESULTS_ANSWER,
        sources,
        interrupted: false,
      };
    }

    // 步骤 5：提示编排 + 流式生成（引用先到，再逐 token 推送）
    const prompt = await buildRagMessages(history, sources, params.question);
    let answer = '';
    try {
      for await (const delta of this.chatModel.stream(prompt, params.signal)) {
        answer += delta;
        params.onDelta(delta);
      }
    } catch (error) {
      // 中断/失败时保留已生成内容：用户看到的半条回答必须能落库
      // 判据与步骤 3 的检索阶段共用 isAbort，两处的「取消」语义必须一致
      const interrupted = isAbort(error, params.signal);
      if (answer) {
        const assistant = await this.messages.insert({
          conversationId: conversation.id,
          role: 'assistant',
          content: answer,
          sources,
          interrupted: true,
        });
        await this.conversations.touch(conversation.id);
        if (!interrupted) throw error;
        return {
          conversationId: conversation.id,
          assistantMessageId: assistant.id,
          answer,
          sources,
          interrupted: true,
        };
      }
      if (interrupted) {
        return {
          conversationId: conversation.id,
          assistantMessageId: null,
          answer: '',
          sources,
          interrupted: true,
        };
      }
      throw error;
    }

    if (!answer.trim()) {
      return {
        conversationId: conversation.id,
        assistantMessageId: null,
        answer: '',
        sources,
        interrupted: false,
      };
    }

    const assistant = await this.messages.insert({
      conversationId: conversation.id,
      role: 'assistant',
      content: answer,
      sources,
    });
    await this.conversations.touch(conversation.id);
    return {
      conversationId: conversation.id,
      assistantMessageId: assistant.id,
      answer,
      sources,
      interrupted: false,
    };
  }
}
