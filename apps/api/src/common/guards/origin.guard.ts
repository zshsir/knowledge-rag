/**
 * Origin 校验守卫：以 APP_GUARD 注册在 AppModule，对每一个 HTTP 路由生效（包括 @Public 路由）；
 * WebSocket 不在它的覆盖范围内，见文末「覆盖范围」。
 * 等价于 CSRF 防护：会话走 httpOnly Cookie，浏览器发出的跨站写请求必然带 Origin 头，
 * 校验「Origin 等于 APP_ORIGIN」就能拦掉「别的站点带着用户的 Cookie 来发请求」这一类场景。
 * 放行条件（逐条对应代码）：
 * - GET/HEAD/OPTIONS：视为只读方法，无条件放行（同源部署下本不需要校，留出这条也让
 *   预检与非浏览器客户端省事）
 * - 写方法但请求根本不带 Origin 头（curl、服务端对服务端、部分原生客户端）：也放行——
 *   本守卫只约束浏览器，不能当作「所有调用方都必须自报家门」的白名单机制
 * - Origin 与 APP_ORIGIN 完全一致：放行
 * 失败返回：Origin 存在且不一致时抛 ForbiddenException(403)「请求来源不合法」。
 * 前置事实：main.ts 刻意不调用 enableCors（前后端同源部署），跨站防护全靠这里，
 * 所以 APP_ORIGIN 配错= 要么误杀合法请求、要么形同虚设（见 AppConfigService.appOrigin 注释）。
 * 边界：不验证登录态、不查权限，纯字符串比较，零依赖数据库。
 * 覆盖范围：本守卫只作用于 HTTP；WebSocket 握手不进 Nest 守卫链，realtime.gateway.ts 的
 * server.use 里另有一份独立的 Origin 比对 + SessionService.verify（两份代码各写各的，
 * kb:join / chat:send 两个处理器还会再 verify 一次），头部说的「每一个路由」只指 HTTP 路由表。
 * 改 Origin 规则必须两处同步，否则 WS 会悄悄沿用旧口径。
 */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { AppConfigService } from '../../config/config.service';
import { AuthenticatedRequest } from '../types';

@Injectable()
export class OriginGuard implements CanActivate {
  constructor(private readonly config: AppConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    // 只读方法直接放过，CSRF 的风险面集中在会改状态的写方法上
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return true;

    // 写方法：只有「带了 Origin 且与 APP_ORIGIN 不一致」才拒绝；字段缺失视为非浏览器客户端放行
    const origin = request.headers.origin;
    if (typeof origin === 'string' && origin !== this.config.appOrigin) {
      throw new ForbiddenException('请求来源不合法');
    }
    return true;
  }
}
