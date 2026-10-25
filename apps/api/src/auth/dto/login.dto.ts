/**
 * POST /auth/login 的请求体校验（规则说明与校验执行口径见 register.dto 文件头）。
 * 与注册的差异：这里不设 MinLength——登录不重复执行口令强度策略，
 * 只管把候选口令原样交给服务层做 bcrypt 比对（历史注册的口令不受影响）。
 */
import { IsEmail, IsString, MaxLength } from 'class-validator';

export class LoginDto {
  @IsEmail()
  @MaxLength(200)
  email!: string; // 大小写不敏感匹配（仓储按 lower(email) 查询）

  @IsString()
  @MaxLength(72)
  password!: string; // 上限与注册同源（bcrypt 72 字节截断），但不设下限
}
