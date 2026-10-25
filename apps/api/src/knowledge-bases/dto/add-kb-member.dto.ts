/**
 * POST /orgs/:orgId/knowledge-bases/:kbId/members 的请求体：加一个人进知识库。
 * 执行者是 main.ts 的全局 ValidationPipe（whitelist 丢弃未声明字段、transform 转类型）。
 * userId 与 email 是一对「二选一」的入口，但两者都标了 @IsOptional：
 * 本文件用的是单字段校验器，没有跨字段约束（无 @ValidateIf、无自定义 validator），
 * 所以「两个都不给」能过校验层，由 KbMembersService.add 抛 400「请提供成员 ID 或邮箱」；
 * 「两个都给」也能过，服务里 userId 优先、email 分支整个被跳过。
 * 边界：这里不校验这个人存不存在、是不是本组织成员——那是服务层的事。
 * KbMembersService.add 的 userId 分支会用 isMember 复核组织归属：
 * 非本组织成员（以及查无成员关系的不存在 id）一律 404「该用户不在组织中」，
 * 不会写授权行；只有创建者与组织 owner/admin 才会被挡成 400。
 * 邮箱查无此人时接口的返回体会换成一条邀请链接（{ invited: true, invite }），
 * 这条语义差异也在服务层，不在 DTO。
 */
import { IsEmail, IsIn, IsOptional, IsUUID } from 'class-validator';

export class AddKbMemberDto {
  /** 已注册用户的 id：直接授权分支用它；只保证是合法 UUID，不保证这个人属于本组织 */
  @IsOptional()
  @IsUUID()
  userId?: string;

  /** 邮箱：命中已注册用户就直接授权（不在本组织则先补成员关系），查无此人则改成发邀请链接 */
  @IsOptional()
  @IsEmail()
  email?: string;

  /**
   * 要授予的权限等级，必填。注意两点现状：
   * - 允许给 'manager'：对该库是 manager 的人可以把别人也提成 manager，没有「不能高于自己」的规则
   * - 没有任何「不能加自己 / 不能改自己」的限制，所以被显式授权的 manager 也能把自己降成 viewer
   *   并真的失去管理能力（下一次的 resolve 就按那一行算了）
   */
  @IsIn(['viewer', 'editor', 'manager'])
  permission!: 'viewer' | 'editor' | 'manager';
}
