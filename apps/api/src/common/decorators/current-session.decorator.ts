/**
 * 参数装饰器：把 request.sessionId（当前会话在 sessions 表的主键，AuthGuard 校验时写入）注入入参。
 * 用途：登出时删自己这一条会话；改密码时用它作为 revokeOthers 的「保留白名单」，
 * 避免用户改完密码当场把自己踢下线。
 * 取不到会怎样：同 CurrentUser——@Public 路由没有登录态，运行时是 undefined。
 */
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthenticatedRequest } from '../types';

export const CurrentSession = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    return request.sessionId!;
  },
);
