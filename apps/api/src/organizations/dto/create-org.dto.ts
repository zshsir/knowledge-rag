/**
 * POST /orgs 的请求体：只有一个组织名。
 * 执行者是 main.ts 的全局 ValidationPipe（whitelist 丢弃未声明字段、transform 转类型），
 * 本文件只声明规则、不含逻辑；校验失败由 AllExceptionsFilter 把 message 数组原样透出。
 * 边界：不校验组织名是否重复（租户身份靠 id，不靠 name），也不做 trim——
 * 去空白是 OrganizationsService.create 的事；长度数的是 trim 之前的字符数。
 */
import { IsString, Length } from 'class-validator';

export class CreateOrgDto {
  /** 组织名：1–60 字符。全是空白的值能过校验，进服务层 trim 后会写成空名字（本层不做非空白判断） */
  @IsString()
  @Length(1, 60)
  name!: string;
}
