/**
 * PATCH /orgs/:orgId/knowledge-bases/:kbId 的请求体：改库名 / 描述 / 可见模式，三个都可单独给。
 * 执行者是 main.ts 的全局 ValidationPipe（whitelist 丢弃未声明字段、transform 转类型）。
 * 「省略字段=保持原值」这件事不在这里实现：DTO 只负责形状，
 * 未传字段由 KnowledgeBasesService.update 先读当前行再合并（仓储层的 UPDATE 是全字段覆盖）。
 * 两处不对称要看清：
 * - description 传空串是合法的（@IsOptional 只跳过 undefined），会真的把描述清空；
 *   name 传空串则过不了 @Length(1,60) → 400，所以描述可以清空、库名不行
 * - accessMode 改成 'restricted' 会让「纯靠组织公开模式看见这个库」的人立刻失去访问，
 *   服务层在那条路径上算出受影响人群并广播权限回收事件，DTO 层不知道也不需要知道
 */
import { IsIn, IsOptional, IsString, Length, MaxLength } from 'class-validator';

export class UpdateKbDto {
  /** 新库名：省略则沿用旧名；给了就必须是 1–60 字符 */
  @IsOptional()
  @IsString()
  @Length(1, 60)
  name?: string;

  /** 新描述：省略=沿用旧值，传空串=清空 */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  /** 新可见模式：'org' ↔ 'restricted'，只有 manager 能改（路由门槛，不是这里） */
  @IsOptional()
  @IsIn(['org', 'restricted'])
  accessMode?: 'org' | 'restricted';
}
