/**
 * 认证与权限层的共享类型：用户身份、组织角色、知识库权限等级，以及「鉴权完成后」的请求形状。
 *
 * 边界：
 * - 纯类型文件，编译后即被擦除，不含任何运行时代码，也不放常量（常量跟随各自的功能文件）
 * - AuthenticatedRequest 是对 Express Request 的宽松再声明：只列鉴权层关心的字段，
 *   body/params/query 等仍由各自控制器按原生类型取用，这里不做完整镜像
 */

/**
 * 对外安全形态的用户三件套。
 * 刻意不含 password_hash：所有出网响应（/auth/me、登录返回等）都用这个形状，
 * 从类型层面杜绝把口令哈希带进 JSON。
 */
export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

/** 组织级角色。owner/admin 在知识库权限解析时都会被直接视为 manager（见 KbAccessService.resolve） */
export type OrgRole = 'owner' | 'admin' | 'member';

/** /auth 各接口返回给前端的组织列表项：前端据此渲染组织切换器并知道自己在该组织的角色 */
export interface OrgSummary {
  id: string;
  name: string;
  role: OrgRole;
}

/**
 * 知识库权限等级，由低到高：viewer（只读/问答）< editor（可传文档、改内容）< manager（可管成员与设置）。
 * 「高等级蕴含低等级」的比较不写在类型里，而是靠两处各自维护的 RANK 映射表：
 * common/guards/kb-permission.guard.ts 与 knowledge-bases/kb-access.service.ts。
 */
export type KbPermission = 'viewer' | 'editor' | 'manager';

/**
 * 鉴权链跑完之后的请求形状（仅类型标注，运行时字段由守卫原地挂上）。
 * 每个字段的填充者与填充时机：
 * - cookies：cookie-parser（main.ts 挂载）解析 Cookie 头得到；没有该中间件时整个字段不存在
 * - headers/method：Node/Express 原生字段，本接口只是重新声明成守卫实际读取的宽松类型
 * - user / sessionId：全局 AuthGuard 校验会话通过后写入（@Public 路由不经过校验，保持 undefined）
 * - membership：OrgMemberGuard 按路由参数 orgId 查成员关系命中后写入
 * - kbPermission：KbPermissionGuard 解析出有效权限、且确认达到路由要求的门槛后才写入
 * 全部可选：读到 undefined 意味着对应守卫没跑过，而不是「值为空」。
 */
export interface AuthenticatedRequest {
  cookies?: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  method: string;
  user?: AuthUser;
  sessionId?: string;
  membership?: { orgId: string; userId: string; role: OrgRole };
  kbPermission?: KbPermission;
}
