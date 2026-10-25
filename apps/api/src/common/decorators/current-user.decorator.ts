/**
 * 参数装饰器：把 request.user（由全局 AuthGuard 校验会话后写入）直接注入到控制器方法入参。
 * 取不到会怎样：@Public() 路由（注册/登录/健康探针/邀请页）AuthGuard 直接放行、不写 user，
 * 此时返回值运行时是 undefined——返回类型靠 `!` 断言成 AuthUser，类型系统不会报警，
 * 所以只能用在「确定带登录态」的路由上。
 */
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthenticatedRequest, AuthUser } from '../types';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    return request.user!;
  },
);
