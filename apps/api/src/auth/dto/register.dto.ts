/**
 * POST /auth/register 的请求体校验。
 * 执行者是 main.ts 的全局 ValidationPipe（whitelist 丢弃未声明字段、transform 转类型），
 * 本文件只声明规则、不含任何逻辑；校验失败由 AllExceptionsFilter 透出 message 数组。
 */
import {
  IsEmail,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  MinLength,
} from 'class-validator';

export class RegisterDto {
  @IsString()
  @Length(1, 50)
  name!: string; // 显示名，1~50 字符；服务层只做 trim，不做唯一性

  @IsEmail()
  @MaxLength(200)
  email!: string; // 登录凭证；服务层 trim+小写后入库，查重按 lower(email)

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password!: string; // 8~72：下限是策略，上限因 bcrypt 静默截断 72 字节之后的内容，宁可拒不可截

  @IsOptional()
  @IsString()
  @Length(1, 60)
  orgName?: string; // 仅「无邀请链接的自助注册」必填（服务层校验缺它 400）；带邀请时这个字段被忽略

  @IsOptional()
  @IsString()
  @Length(10, 200)
  inviteToken?: string; // 邀请链接里的原始令牌（非摘要）；服务层算 SHA-256 后查 invites
}
