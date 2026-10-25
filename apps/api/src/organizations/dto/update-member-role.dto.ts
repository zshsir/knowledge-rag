/**
 * PATCH /orgs/:orgId/members/:userId 的请求体：把某个成员改成 admin 或 member。
 * 执行者是 main.ts 的全局 ValidationPipe（whitelist 丢弃未声明字段、transform 转类型）。
 * 关键点：@IsIn 的白名单里没有 'owner'，所以「通过接口制造第二个 owner」在校验层就不可能，
 * 与 invites.role / memberships.role 上的数据库 CHECK 约束是同一套口径（两道都拦，改一处不够）。
 * 至于「谁能改」——owner 专属、且目标不能是 owner——写在 MembersService.updateRole，不在这里。
 */
import { IsIn } from 'class-validator';

export class UpdateMemberRoleDto {
  /** 目标角色：只接受 admin / member，不含 owner，也不含降级到「无角色」（移除成员是另一条路由） */
  @IsIn(['admin', 'member'])
  role!: 'admin' | 'member';
}
