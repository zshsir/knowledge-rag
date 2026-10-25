/**
 * 对话 REST 控制器：HTTP 侧的会话入口，共四个路由（列表 / 新建 / 取消息 / 删除）。
 * 职责：声明守卫与参数形状，然后把请求原样转交给 ChatService；
 *      本文件不写 SQL、不拼提示词、不做生成与检索，也不处理 WebSocket 问答
 *      （问答编排在 chat.service.ts 的 run，实时入口在 realtime/realtime.gateway.ts）。
 * 鉴权与租户隔离由三层拼出来，分工如下（这是本文件最需要看明白的地方）：
 * - 全局 AuthGuard（APP_GUARD，见 auth 模块）先跑：没登录拿不到 request.user，四个路由都是 401。
 * - 类级 @UseGuards(OrgMemberGuard) 对四个路由都生效：非该 orgId 的成员在进控制器前被挡成 404。
 * - 知识库级 viewer 校验分两种位置，别混淆：
 *   · list / create：路由参数里直接有 kbId，所以贴了 @UseGuards(KbPermissionGuard) +
 *     @RequireKbPermission('viewer')，在进控制器之前判；ChatService 内部又判一次
 *     （chat.service.ts 的 listConversations / createConversation 开头各自 await kbAccess.require）。
 *   · messages / remove：路由参数只有 conversationId，不贴 KbPermissionGuard 是因为
 *     KbPermissionGuard 必须从参数里取 kbId（kb-permission.guard.ts 步骤 2：取不到就 404），
 *     而这里得先按 (orgId, userId) 反查会话才知道它属于哪个库。该判留在 ChatService 里：
 *     先 conversations.findOwnedById(orgId, userId, conversationId)，查不到一律 404「会话不存在」，
 *     再用查出来的 conversation.kbId 走 kbAccess.require(..., 'viewer')。
 *     后果：拿别人的 conversationId 或换错 orgId 都只会得到 404，不会泄露「这个会话存在」。
 * - 归属判定始终以 @CurrentUser() 的 user.id 为准，四个方法都把 user.id 往下传，
 *   客户端无法通过 body 或 query 指定「我是谁」。
 * 覆盖本文件的端到端用例：test/conversations.e2e-spec.ts（建/列/读/删一条链，
 * 以及「别人的会话读不到 → 404」）。
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequireKbPermission } from '../common/decorators/require-kb-permission.decorator';
import { KbPermissionGuard } from '../common/guards/kb-permission.guard';
import { OrgMemberGuard } from '../common/guards/org-member.guard';
import { AuthUser } from '../common/types';
import { ChatService } from './chat.service';
import { CreateConversationDto } from './dto/create-conversation.dto';

@UseGuards(OrgMemberGuard)
@Controller('orgs/:orgId')
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  /**
   * 列出「当前用户」在某个知识库里的会话（GET /orgs/:orgId/knowledge-bases/:kbId/conversations）。
   * 步骤：
   * 1. ParseUUIDPipe 先把 orgId/kbId 校成 UUID，格式不对直接 400，不会带着脏参数进服务层
   * 2. OrgMemberGuard + KbPermissionGuard(viewer) 在进方法前判完两级权限
   * 3. 转交 ChatService.listConversations，由它再判一次 kbAccess 并按 user.id 过滤会话
   * 返回值就是服务层的会话数组，本层不做二次包装（新建/删除的返回同理）。
   */
  @UseGuards(KbPermissionGuard)
  @RequireKbPermission('viewer')
  @Get('knowledge-bases/:kbId/conversations')
  list(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('kbId', ParseUUIDPipe) kbId: string,
    @CurrentUser() user: AuthUser,
  ) {
    // 步骤 3：userId 取自登录态，不接受客户端传参
    return this.chat.listConversations(user.id, orgId, kbId);
  }

  /**
   * 新建会话（POST /orgs/:orgId/knowledge-bases/:kbId/conversations）。
   * 步骤：
   * 1. 两级守卫同上（组织成员 + 该库 viewer 及以上）
   * 2. body 走 CreateConversationDto 校验；只把 dto.title 往下传，多余字段已被全局
   *    ValidationPipe 的 whitelist 丢弃（main.ts:35）
   * 3. ChatService.createConversation 里补默认标题并落库，返回新建的会话
   * 这里不校验标题内容：默认值与 trim 都在服务层（title?.trim() || '新对话'），
   * 保证 WebSocket 侧「不带标题建会话」走的是同一套规则。
   */
  @UseGuards(KbPermissionGuard)
  @RequireKbPermission('viewer')
  @Post('knowledge-bases/:kbId/conversations')
  create(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('kbId', ParseUUIDPipe) kbId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateConversationDto,
  ) {
    return this.chat.createConversation(user.id, orgId, kbId, dto.title);
  }

  /**
   * 读取一个会话的全部消息（GET /orgs/:orgId/conversations/:conversationId/messages）。
   * 步骤：
   * 1. OrgMemberGuard 保证这个人在这条 URL 的 orgId 里
   * 2. ChatService.listMessages 按 (orgId, userId, conversationId) 反查会话：
   *    查不到（包括「会话存在但不属于你」和「会话属于你但在别的组织」）统一 404
   * 3. 命中后用会话自己的 kbId 判 viewer 权限，再返回消息列表
   * 注意路由上没有 :kbId——正因为如此本方法不贴 KbPermissionGuard，权限判在服务层。
   */
  @Get('conversations/:conversationId/messages')
  messages(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.chat.listMessages(user.id, orgId, conversationId);
  }

  /**
   * 删除一个会话（DELETE /orgs/:orgId/conversations/:conversationId）。
   * 步骤与 messages 完全同构：先按归属反查（不存在/不是你的 → 404）→ 再按该会话的 kbId
   * 判 viewer → 才真正删除；返回 ChatService 给的 { ok: true }。
   * 这里没有「删除需要更高权限」的门槛：会话是用户自己的对话记录，viewer 即可清理。
   */
  @Delete('conversations/:conversationId')
  remove(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.chat.deleteConversation(user.id, orgId, conversationId);
  }
}
