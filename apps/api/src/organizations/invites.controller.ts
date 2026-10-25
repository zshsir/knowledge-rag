/**
 * 邀请对外的两个入口，挂在 /invites 下。路径不带 :orgId，所以两条路由都不经过 OrgMemberGuard；
 * 组织身份是从邀请行里读出来的，请求方无从自报要加入哪个组织。
 *
 * 两条路由的鉴权形态不一样，这是本文件唯一需要小心的地方：
 * - GET /invites/:token 标了 @Public，豁免全局 AuthGuard：被邀请人此刻还没登录也要能看到确认页，
 *   凭据就是链接里的原始令牌本身（InvitesService.publicInfo 只回组织名/角色/valid/过期时间）。
 *   另用 @Throttle 把它收紧到 30 次/分钟（全局额度是 60 秒 100 次，见 app.module 与 auth.controller）：
 *   它是一个无需登录即可调用的接口，限流是给「拿同一批令牌反复打」的探测准备的
 * - POST /invites/:token/accept 不标 @Public，因此要过全局 AuthGuard：@CurrentUser() 拿到的
 *   userId 来自会话而不是请求体，被邀请人必须是已注册并已登录的人
 *   （「带着链接直接注册新用户」走的是另一条路：POST /auth/register 的 inviteToken 分支）
 * 边界：控制器不校验令牌、不判有效期，把路径参数原样交下去；响应体也由服务直接决定。
 */
import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types';
import { InvitesService } from './invites.service';

@Controller('invites')
export class InvitesController {
  constructor(private readonly invites: InvitesService) {}

  /** 确认页数据：无需登录，只读，失败也只是 valid=false（令牌查不到才 404） */
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get(':token')
  publicInfo(@Param('token') token: string) {
    return this.invites.publicInfo(token);
  }

  /**
   * 接受邀请：先登录，再凭令牌补成员资格。
   * @HttpCode(200)：Nest 对 POST 默认回 201，这里的语义不是「新建一个资源给前端取地址」，
   * 而是把当前用户写进组织，与 /auth/login、/auth/logout 一样压回 200。
   * 令牌原样透传，由服务层现算摘要；成功只回 { organization: {id,name,role} }，不动会话与 Cookie。
   */
  @HttpCode(HttpStatus.OK)
  @Post(':token/accept')
  accept(@CurrentUser() user: AuthUser, @Param('token') token: string) {
    return this.invites.accept(user.id, token);
  }
}
