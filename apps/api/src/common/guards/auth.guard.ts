/**
 * 全局登录守卫：由 AuthModule 以 APP_GUARD 注册，对每一个 HTTP 路由生效。
 * 拦什么：没有有效会话的请求（401）。放行条件：路由标了 @Public()。
 * 步骤：
 * 1. 读 @Public() 元数据（getAllAndOverride：handler 优先于 class），是 public 直接放行，
 *    放行后 request.user/sessionId 都不会被写入——这是 @CurrentUser() 在公开路由上拿到 undefined 的根源
 * 2. 从 cookie 取会话令牌 kr_session（cookie-parser 在 main.ts 挂上后 request.cookies 才存在），
 *    没带 cookie → 401「请先登录」
 * 3. 交 SessionService.verify 用 SHA-256 摘要反查会话；不存在或已过期 → 401「登录已过期，请重新登录」
 *    （两种失败对外同一句话，不给探测者区分「曾经存在」的机会）
 * 4. 通过后把 user 与 sessionId 挂到 request 上，供 @CurrentUser()/@CurrentSession() 读取
 * 边界：只验证「登录过没有」，不判断属于哪个组织、有没有知识库权限——那是 OrgMemberGuard /
 * KbPermissionGuard 在控制器层的事；也不签发、不删除会话。
 */
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { AuthenticatedRequest } from '../types';
import { SessionService } from '../../auth/session.service';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // 步骤 1：@Public() 豁免——注册/登录/健康探针/邀请页四处在用
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    // 步骤 2：取会话令牌；cookie 名与 session.service 的 SESSION_COOKIE 是同值字面量
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const rawToken = request.cookies?.kr_session;
    if (!rawToken) {
      throw new UnauthorizedException('请先登录');
    }

    // 步骤 3：摘要反查会话（顺带刷 last_used_at），失败统一 401
    const session = await this.sessions.verify(rawToken);
    if (!session) {
      throw new UnauthorizedException('登录已过期，请重新登录');
    }

    // 步骤 4：把身份挂到 request，本次请求后续环节（守卫/控制器）直接读
    request.user = session.user;
    request.sessionId = session.sessionId;
    return true;
  }
}
