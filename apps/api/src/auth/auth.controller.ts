/**
 * 认证控制器：/api/auth 下注册、登录、登出、me、改密的 HTTP 边界。
 * 职责分工：身份校验逻辑全在 AuthService，会话签发在 SessionService，
 * 本层只做参数收口、编排调用，以及唯一一个「只有控制器能干」的事——写/清会话 Cookie。
 * 登录态豁免：register/login 标 @Public()，其余三个接口由全局 AuthGuard 把关，
 * 因此 @CurrentUser()/@CurrentSession() 在这三个路由上必然有值。
 * 边界：不做组织/知识库权限判断（进不了本文件的话题），不碰数据库。
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CurrentSession } from '../common/decorators/current-session.decorator';
import { AuthUser } from '../common/types';
import { AppConfigService } from '../config/config.service';
import { AuthService } from './auth.service';
import { SESSION_COOKIE, SessionService } from './session.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { ChangePasswordDto } from './dto/change-password.dto';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: AppConfigService,
    private readonly sessions: SessionService,
  ) {}

  /**
   * 会话 Cookie 的唯一写入口：httpOnly 挡 XSS 窃取、sameSite=lax 挡大部分 CSRF
   * （剩下的跨站写请求由 OriginGuard 兜底）、path=/ 全站可带。
   * secure 跟随 COOKIE_SECURE（本地 http 必须能登录，默认不加）；
   * maxAge 与库里 expires_at 同源（都吃 SESSION_TTL_DAYS），否则会出现「浏览器还带着
   * 一个库里已死的 Cookie」这种更难排查的半衰状态。
   */
  private setCookie(res: Response, rawToken: string) {
    res.cookie(SESSION_COOKIE, rawToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.cookieSecure,
      path: '/',
      maxAge: this.config.sessionTtlDays * 24 * 60 * 60 * 1000,
    });
  }

  /**
   * POST /auth/register：注册即登录。
   * 步骤：AuthService.register 落用户与组织关系 → 成功后立即 createSession 签发会话
   *       → setCookie 写进浏览器 → 返回 { user, organizations }。
   * 限流：@Throttle 收紧到 10 次/小时（默认 100 次/分挡不住批量开号）。
   */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 3_600_000 } })
  @Post('register')
  async register(
    @Body() dto: RegisterDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    // passthrough：手动写 Set-Cookie 但让 Nest 继续负责序列化返回体，两者不冲突
    const result = await this.auth.register(dto);
    // 注册失败走不到这里（异常先抛出），所以「能建会话」必然意味着用户已落库
    const session = await this.sessions.createSession(result.user.id);
    this.setCookie(res, session.rawToken);
    return { user: result.user, organizations: result.organizations };
  }

  /**
   * POST /auth/login：邮箱密码换会话，成功同样「签发新会话+写 Cookie」（每次登录一条新会话行）。
   * 限流：5 次/分钟，对着暴力猜密码的最小成本防线；失败信息统一，见 AuthService.login。
   * @HttpCode(200)：Post 默认回 201，登录语义上不是「创建资源给前端」，压回 200。
   */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.login(dto);
    const session = await this.sessions.createSession(result.user.id);
    this.setCookie(res, session.rawToken);
    return { user: result.user, organizations: result.organizations };
  }

  /** POST /auth/logout：删服务端当前会话行 + 清浏览器 Cookie，两头同时归零，不留半死会话 */
  @HttpCode(HttpStatus.OK)
  @Post('logout')
  async logout(
    @CurrentSession() sessionId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.auth.logout(sessionId);
    // clearCookie 需带上与写入时一致的 path，否则删不掉 path=/ 下的那条
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }

  /** GET /auth/me：前端启动时恢复登录态用；身份由守卫注入，本接口只是把它和最新组织列表再查一遍 */
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user);
  }

  /**
   * POST /auth/password：改密码。
   * 把 sessionId 一路传进服务层，是为了改完后「踢掉其他设备、保住当前这个会话」（见 changePassword）。
   */
  @HttpCode(HttpStatus.OK)
  @Post('password')
  async changePassword(
    @CurrentUser() user: AuthUser,
    @CurrentSession() sessionId: string,
    @Body() dto: ChangePasswordDto,
  ) {
    await this.auth.changePassword(user.id, sessionId, dto);
    return { ok: true };
  }
}
