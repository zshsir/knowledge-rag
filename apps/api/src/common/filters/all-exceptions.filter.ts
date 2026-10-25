/**
 * 全局异常过滤器：以 APP_FILTER 注册，兜住所有控制器的异常，保证错误响应只有一个形状。
 * 统一形状：{ statusCode, message, error }——前端只需认这三个字段。
 * 步骤：
 * 1. 响应头已发出（如流式写出后我才炸出来的错误）：直接放弃，往已发送的响应上再写一次
 *    只会让 Express 抛第二层的 ERR_HEADERS_SENT，把现场弄得更乱；代价是这个分支连日志也不记，
 *    流式请求里发生的异常在本层不留痕迹
 * 2. 定状态码：HttpException 取它自己的码，其余一律 500——业务代码之外的异常（数据库断连、
 *    JSON 解析炸了）绝不能带着原始信息出网
 * 3. 提取 message：HttpException 的 getResponse() 可能是字符串（如守卫里 new Forbidden('...')）
 *    或带 message 字段的对象（class-validator 校验失败时 message 是 string[]，原样透出，
 *    前端逐条展示）；非 HttpException 保持默认的「服务器内部错误」——框架外炸出来的异常
 *    （含堆栈的原始信息）就此挡住，只剩一句安全文案；注意对 5xx 的 HttpException 本过滤器
 *    不二次改写，主动抛的文案照旧透出
 * 4. 记日志：仅 status>=500 才打（带堆栈），4xx 属预期业务分支，打了只会淹没日志
 * 边界：只重塑响应体、不改状态码语义；error 字段用 HttpStatus 反查枚举名，遇到该枚举没登记的
 * 状态码（如 499）时兜底为 'Error'。
 */
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    // 步骤 1：响应已发出就别再动它
    if (response.headersSent) return;

    // 步骤 2：HttpException 自带状态码；其余（含普通 Error）按服务器错误处理
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    // 步骤 3：5xx 对外只留一句「服务器内部错误」，4xx 把框架/守卫写的用户文案透出去
    let message: string | string[] = '服务器内部错误';
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
      } else if (body && typeof body === 'object' && 'message' in body) {
        // ValidationPipe 的失败项在这里是 string[]，原样透出供前端逐条提示
        message = (body as { message: string | string[] }).message;
      } else {
        message = exception.message;
      }
    }

    // 步骤 4：5xx 才落日志（含堆栈）；4xx 是给正常业务流用的，不值得刷屏
    if (status >= 500) {
      this.logger.error(
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response.status(status).json({
      statusCode: status,
      message,
      // 用 HttpStatus 的双向映射把数字换回 'NOT_FOUND' 这类枚举名，未知码兜底 'Error'
      error: HttpStatus[status] ?? 'Error',
    });
  }
}
