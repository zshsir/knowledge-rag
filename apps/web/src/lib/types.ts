/**
 * 前端这一侧的响应契约：每个接口对应一条（组）后端路由的返回体，字段一律 camelCase。
 *
 * 一致性来源：后端不把类型发包给前端，这些形状是手写镜像——真正的产生点在
 * apps/api/src/**（逐条注释里点名了文件与行号），后端改了字段这里不会编译报错，只会在运行时变 undefined。
 * 数据库行 → 响应体的 snake_case→camelCase 映射全在仓储层的 map 函数里，本文件看不到那一层。
 * 边界：纯类型，没有任何运行时校验、转换或默认值；也不描述请求体（各页面的 DTO 就地写在调用处）。
 */

/** 组织角色，与后端 common/types.ts:22 的 OrgRole 同字面量（owner/admin 在知识库层会被直接视为 manager） */
export type OrgRole = 'owner' | 'admin' | 'member';
/** 知识库权限等级（viewer < editor < manager），抄后端 common/types.ts:36；大小关系不写在类型里 */
export type KbPermission = 'viewer' | 'editor' | 'manager';
/** 知识库可见范围，抄后端 knowledge-bases.repository.ts:30 的 access_mode（org=全组织可见，restricted=仅授权者） */
export type AccessMode = 'org' | 'restricted';
/** 文档入库状态机，抄后端 documents.repository.ts:16 的 DocumentStatus */
export type DocumentStatus = 'queued' | 'processing' | 'ready' | 'failed';

/** 对应后端 AuthUser（common/types.ts:15-19）：出网的用户三件套，刻意不含口令哈希 */
export interface User {
  id: string;
  email: string;
  name: string;
}

/** 对应后端 OrgSummary（common/types.ts:24-29）：组织切换器的一项，role 是「我」在该组织的角色 */
export interface Organization {
  id: string;
  name: string;
  role: OrgRole;
}

/** 对应 auth.service.ts 的 AuthResponse：POST /auth/login、/auth/register 与 GET /auth/me 三条路由共用同一个返回体 */
export interface MeResponse {
  user: User;
  organizations: Organization[];
}

/**
 * 对应知识库四条读/写路由（GET/POST /orgs/:orgId/knowledge-bases、GET/PATCH .../:kbId）。
 * effectivePermission 由服务层附加：列表逐个现算（knowledge-bases.service.ts:75-88），
 * create 与 PATCH 写死 'manager'（:114、:198，两者的门槛都保证了解析结果必然是 manager）。
 * 两个 count 只有列表 SQL 会带（knowledge-bases.repository.ts:94-95），create 由服务层
 * （knowledge-bases.service.ts:115-116）回填 0，详情与 PATCH 根本不带——所以它们在前端只能是可选字段。
 */
export interface KnowledgeBase {
  id: string;
  orgId?: string;
  name: string;
  description: string;
  accessMode: AccessMode;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  effectivePermission: KbPermission;
  documentCount?: number;
  memberCount?: number;
}

/** 对应后端 publicDocument() 的产物（documents.service.ts:35-42）：DocumentRow 去掉 storageKey，列表与上传/重试返回体都用它 */
export interface DocumentItem {
  id: string;
  orgId: string;
  kbId: string;
  uploadedBy: string | null;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  status: DocumentStatus;
  error: string | null;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
}

/** 对应 GET /orgs/:orgId/documents/:documentId/chunks 的数组元素（documents.repository.ts:159-163），只给预览用 */
export interface DocumentChunk {
  id: string;
  chunkIndex: number;
  content: string;
}

/** 检索命中片段：后端 chat/sources.ts 定义、chat/retrieval.service.ts 的 retrieve()（末尾 return 那串 map→filter→重新编号）产出；既进 chat:meta 也原样存进 messages.sources */
export interface Source {
  index: number;
  documentId: string;
  filename: string;
  chunkId: string;
  chunkIndex: number;
  score: number;
  content: string;
}

/** 对应 GET/POST .../knowledge-bases/:kbId/conversations 的元素（conversations.repository.ts:16-24 的 ConversationRow） */
export interface Conversation {
  id: string;
  orgId: string;
  kbId: string;
  userId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

/** 对应 GET /orgs/:orgId/conversations/:conversationId/messages 的元素（messages.repository.ts:17-25）；sources 为 null 表示这条不是带引用的回答 */
export interface Message {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  sources: Source[] | null;
  interrupted: boolean;
  createdAt: string;
}

/** 对应 GET /orgs/:orgId/members 的元素（memberships.repository.ts:24-30，joinedAt 即 memberships.created_at） */
export interface OrgMember {
  id: string;
  name: string;
  email: string;
  role: OrgRole;
  joinedAt: string;
}

/**
 * 对应 GET .../knowledge-bases/:kbId/members 里 members 与 inherited 两组的元素
 * （kb-members.repository.ts:19-31：显式组是 KbMemberView，继承组多带 inherited/source）。
 * 所以这三个可选字段就是「这人不在授权表里，是推导出来的」的标记，界面据此决定能不能删。
 */
export interface KbMember {
  userId: string;
  name: string;
  email: string;
  permission: KbPermission;
  createdAt?: string;
  inherited?: boolean;
  source?: string;
}

/** 对应上面那条路由的整个返回体 { members, inherited }（kb-members.service.ts:52-57，两条查询并发发出） */
export interface KbMemberList {
  members: KbMember[];
  inherited: KbMember[];
}

/** 对应 POST .../knowledge-bases/:kbId/members 的返回体，两种互斥分支：{added,userId}=当场写授权行，{invited,invite}=邮箱查无此人改发链接（都出自 kb-members.service.ts 的 add()，各自一个 return） */
export interface KbMemberAddResult {
  added?: boolean;
  userId?: string;
  invited?: boolean;
  invite?: CreatedInvite;
}

/** 对应 GET /orgs/:orgId/invites 的元素（invites.repository.ts:90-96）：列表 SQL 刻意不选 token_hash，所以这里拿不到可用令牌 */
export interface Invite {
  id: string;
  role: 'admin' | 'member';
  createdBy: string | null;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
}

/** 对应签发邀请的返回体（invites.service.ts:156-163 的 issueInvite，POST /orgs/:orgId/invites 与知识库级邀请共用）：原始 token 与 url 只在这一份响应里出现一次 */
export interface CreatedInvite {
  id: string;
  token: string;
  role: 'admin' | 'member';
  expiresAt: string;
  url: string;
}

/** 对应 GET /invites/:token 的公开确认页数据（invites.service.ts:213-224，@Public 未登录可读）：valid=false 也是 200，令牌查不到才 404 */
export interface InviteInfo {
  orgName: string;
  role: 'admin' | 'member';
  valid: boolean;
  expiresAt: string;
}

/** 对应 socket 事件 chat:meta（realtime.gateway.ts#chatSend 的 onMeta）：检索完成，先把会话 id、刚落库的用户消息 id 和引用推下来 */
export interface ChatMetaEvent {
  requestId: string;
  conversationId: string;
  userMessageId: string;
  sources: Source[];
}

/** 对应 socket 事件 chat:delta（realtime.gateway.ts#chatSend 的 onDelta）：模型增量文本，一次回答 0 到多次 */
export interface ChatDeltaEvent {
  requestId: string;
  text: string;
}

/** 对应 socket 事件 chat:done（realtime.gateway.ts#chatSend 的第 9 步）：本轮结束；cancelled=true 是被 chat:cancel 打断的常规收尾，不走 error；assistantMessageId 为 null 表示一个字都没落库 */
export interface ChatDoneEvent {
  requestId: string;
  assistantMessageId: string | null;
  conversationId: string;
  cancelled: boolean;
}

/** 对应 socket 事件 chat:error（realtime.gateway.ts 共六处 emit：准入检查 :324-354 与生成失败 :391）：message 已是可直接展示的中文，requestId 用于把事件对上自己发的那一次请求 */
export interface ChatErrorEvent {
  requestId: string;
  message: string;
}

/** 对应 socket 事件 document:status（realtime.gateway.ts#broadcastDocumentStatus）：入库状态变化广播，推给 kb 房间 + 上传者个人房间 */
export interface DocumentStatusEvent {
  documentId: string;
  kbId: string;
  status: DocumentStatus;
  chunkCount: number;
  error: string | null;
}

/** 对应 socket 事件 kb:access-revoked（realtime.gateway.ts#afterInit 的步骤 3）：只带 kbId，是「通知」不是「执法」，真正的拒绝来自下一次请求/消息重新判定 */
export interface AccessRevokedEvent {
  kbId: string;
}
