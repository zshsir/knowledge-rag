/**
 * 对话模块的装配：把「检索 + 生成 + 会话历史」这条 RAG 链装进一个 Nest 模块。
 * 职责：只负责依赖形状与对外接口——导出 ChatService 一个。
 * 不做什么：本模块不含逻辑，也不管 WebSocket（那是 RealtimeModule，它 import 本模块拿 ChatService）、
 *      不管入库（IngestionModule）、不管知识库权限的实现（KbAccessService 由 KnowledgeBasesModule 提供）。
 * 依赖为什么是这三个：
 * - DatabaseModule（@Global）→ DatabaseService 与 MembershipsRepository；
 *   注意 ConversationsRepository / MessagesRepository 不在它那份「只列身份/组织仓储」的清单里，
 *   所以必须像下面那样在本模块 providers 里自己提供，别误以为全局可注入
 * - KnowledgeBasesModule（非 @Global）→ KbAccessService：KbPermissionGuard 与 ChatService 都注入它
 * - LlmModule（@Global）→ EmbeddingsService（检索把问题转向量）与 ChatModelService（流式生成），
 *   这行 import 删得掉、照样注入得到，留着是为了读依赖时一眼看清模型能力从哪来
 * providers 里为什么列两个守卫：控制器用 @UseGuards(Class) 引用它们，
 * 被引用的守卫必须在同一个模块（或全局）里注册过，否则运行时注入不到。
 * 边界：exports 只有 ChatService，RetrievalService 与两个仓储都只在本模块内可见，
 *      外部想绕开 ChatService 直接读会话表是拿不到的。
 */
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { KnowledgeBasesModule } from '../knowledge-bases/knowledge-bases.module';
import { LlmModule } from '../llm/llm.module';
import { OrgMemberGuard } from '../common/guards/org-member.guard';
import { KbPermissionGuard } from '../common/guards/kb-permission.guard';
import { ConversationsRepository } from '../database/repositories/conversations.repository';
import { MessagesRepository } from '../database/repositories/messages.repository';
import { RetrievalService } from './retrieval.service';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';

@Module({
  // LlmModule 是 @Global 的，这里显式 import 只为读代码时能立刻看出：
  // 检索的问题向量来自 EmbeddingsService、流式生成来自 ChatModelService
  imports: [DatabaseModule, KnowledgeBasesModule, LlmModule],
  controllers: [ChatController],
  providers: [
    ConversationsRepository,
    MessagesRepository,
    RetrievalService,
    ChatService,
    OrgMemberGuard,
    KbPermissionGuard,
  ],
  exports: [ChatService],
})
export class ChatModule {}
