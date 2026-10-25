/**
 * PATCH /orgs/:orgId 的请求体：改名，字段形状与 CreateOrgDto 完全一致（同一个 1–60 的 name）。
 * 执行者是 main.ts 的全局 ValidationPipe（whitelist 丢弃未声明字段、transform 转类型）。
 * 边界：这里只有 name，所以「改组织名」之外没有任何东西可以通过这个接口写；
 * 角色门槛（owner 专属）由 OrganizationsService.rename 自查，不在 DTO 里。
 */
import { IsString, Length } from 'class-validator';

export class UpdateOrgDto {
  /** 新组织名：1–60 字符，服务层 trim 后整行覆盖旧名 */
  @IsString()
  @Length(1, 60)
  name!: string;
}
