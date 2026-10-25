/**
 * POST /auth/password 的请求体校验（校验执行口径见 register.dto 文件头）。
 * 两个字段分开定规则：旧密码不设长度下限（登录同口径，验历史口令不受策略影响），
 * 只限 72 上限；新密码复用注册的强度策略 8~72，改密时重新执行强度要求。
 */
import { IsString, MaxLength, MinLength } from 'class-validator';

export class ChangePasswordDto {
  @IsString()
  @MaxLength(72)
  currentPassword!: string; // 服务层 bcrypt 比对，不符则 400「当前密码不正确」

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  newPassword!: string; // 成功后：换哈希 + 踢掉该用户其他所有会话（保留当前）
}
