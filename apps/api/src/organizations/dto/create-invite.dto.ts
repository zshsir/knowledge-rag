/**
 * POST /orgs/:orgId/invites 的请求体：要签一条「接受后成为 admin」还是「成为 member」的链接。
 * 执行者是 main.ts 的全局 ValidationPipe（whitelist 丢弃未声明字段、transform 转类型）。
 * 边界：这个 DTO 只有 role 一个字段——被邀请人的邮箱、有效期、绑定的知识库都不能由请求方指定
 * （有效期固定 7 天、知识库级邀请走的是 POST :kbId/members 而不是这里）。
 * 与 UpdateMemberRoleDto 同形是有意的：能邀请的角色集合 = 能改成的角色集合，都不含 owner。
 */
import { IsIn } from 'class-validator';

export class CreateInviteDto {
  /** 邀请携带的角色：admin 只有 owner 能签（门槛在 InvitesService.create 第 2 步） */
  @IsIn(['admin', 'member'])
  role!: 'admin' | 'member';
}
