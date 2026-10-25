/**
 * PATCH /orgs/:orgId/knowledge-bases/:kbId/members/:userId 的请求体：只有一个新权限等级。
 * 执行者是 main.ts 的全局 ValidationPipe（whitelist 丢弃未声明字段、transform 转类型）。
 * 边界：
 * - 改的是谁来自路径参数 :userId，不在这里传；请求体只能决定「改成什么」，无法指定目标
 * - 只改显式授权行：组织 owner/admin 与库创建者的 manager 是推导出来的、不在表里，
 *   用这个接口改不到他们（服务层查不到行就 404）
 * - 撤销授权是 DELETE 同一路径，不是把 permission 改成某个「无权限」值——类型里根本没有那个选项
 */
import { IsIn } from 'class-validator';

export class UpdateKbMemberDto {
  /** 新的权限等级：三挡都允许，包括把人提成 manager；本层不做「谁可以给到 manager」的判断 */
  @IsIn(['viewer', 'editor', 'manager'])
  permission!: 'viewer' | 'editor' | 'manager';
}
