/**
 * POST /orgs/:orgId/knowledge-bases 的请求体：建一个库。
 * 执行者是 main.ts 的全局 ValidationPipe（whitelist 丢弃未声明字段、transform 转类型）。
 * 边界：
 * - orgId 与 created_by 都不在这里——前者来自路由参数（OrgMemberGuard 已校验），
 *   后者由服务层用当前登录用户写入
 * - accessMode 可以不传，缺省值 'org' 是 KnowledgeBasesService.create 里用 ?? 补的，
 *   不是这里的默认值：DTO 不做业务默认，避免「校验层偷偷改了可见性范围」
 * - name 只校验长度 1–60，不校验同组织内重名（允许两个同名库，身份靠 kbId）
 */
import { IsIn, IsOptional, IsString, Length, MaxLength } from 'class-validator';

export class CreateKbDto {
  /** 库名：必填，1–60 字符；服务层 trim，全空白会 trim 成空名字（长度数的是 trim 前） */
  @IsString()
  @Length(1, 60)
  name!: string;

  /** 描述：可省略，最长 500 字符；省略与传空串都落成空字符串 */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  /** 可见模式：'org' 全组织成员至少 viewer；'restricted' 只认创建者/管理员穿透与显式授权行 */
  @IsOptional()
  @IsIn(['org', 'restricted'])
  accessMode?: 'org' | 'restricted';
}
