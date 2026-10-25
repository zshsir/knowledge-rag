/**
 * 会话服务：随机 32 字节 base64url 令牌，库里只存 SHA-256 摘要。
 * 步骤：
 * 1. 签发：生成明文令牌 → 只把 hashToken(raw) 摘要连同 expires_at（按 SESSION_TTL_DAYS 一次算死）
 *    入库 → 明文返回给调用方写 Cookie——这是明文令牌唯一一次、也是唯一可见的出场机会
 * 2. 校验：拿请求里的明文算摘要反查会话；查不到/已过期返回 null，由调用方（AuthGuard、
 *    WebSocket 握手）统一报「未登录/已过期」，不区分「不存在」和「已过期」。
 *    反查命中后顺手 touch 一下：last_used_at 只是审计字段，expires_at 不会被续——
 *    本系统没有滑动续期，会话寿命在签发那一刻就定死了
 * 3. 失效：登出删当前会话行；改密码删除当前外的全部会话行（踢掉其他设备）
 * 边界：不缓存会话、不写 Cookie（那是 auth 控制器的事）；被移出组织/知识库不删会话——
 * 会话只回答「他登录过」，每次请求能不能进门由组织/知识库守卫现场判定。
 */
import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { AppConfigService } from '../config/config.service';
import { hashToken } from '../config/env.util';
import { SessionsRepository } from '../database/repositories/sessions.repository';
import { AuthUser } from '../common/types';

/** Cookie 名：AuthGuard 与 realtime 网关都按这个名字取令牌（两处是字面量，改名必须同步） */
export const SESSION_COOKIE = 'kr_session';

@Injectable()
export class SessionService {
  constructor(
    private readonly sessions: SessionsRepository,
    private readonly config: AppConfigService,
  ) {}

  /** 签发新会话：明文令牌只在返回值里出现一次，落库的永远是摘要 */
  async createSession(userId: string) {
    // 32 字节随机数 ≈ 256 bit 熵；base64url 保证能安全放进 Cookie 与 Set-Cookie 头
    const rawToken = randomBytes(32).toString('base64url');
    // 过期时间在应用侧算好交给库（与控制器里 Cookie 的 maxAge 同源同值，SESSION_TTL_DAYS 是唯一旋钮）
    const expiresAt = new Date(
      Date.now() + this.config.sessionTtlDays * 24 * 60 * 60 * 1000,
    );
    const sessionId = await this.sessions.create(
      userId,
      hashToken(rawToken),
      expiresAt,
    );
    return { rawToken, sessionId, expiresAt };
  }

  /**
   * 用请求携带的明文令牌换回 { user, sessionId }；无效一律返回 null（两种失败不可区分）。
   * 调用方：AuthGuard（每个 HTTP 请求）与 realtime 网关（WS 握手/重连）。
   */
  async verify(
    rawToken: string,
  ): Promise<{ user: AuthUser; sessionId: string } | null> {
    const session = await this.sessions.findValidByTokenHash(hashToken(rawToken));
    if (!session) return null;
    // 只刷新 last_used_at（审计用），不延长有效期——见文件头「无滑动续期」的说明
    await this.sessions.touch(session.sessionId);
    return session;
  }

  /** 登出：删除当前这一条会话，其他设备不受影响 */
  async revoke(sessionId: string): Promise<void> {
    await this.sessions.deleteById(sessionId);
  }

  /** 改密码后的「原地独占」：删掉该用户其他所有会话，唯独保留 currentSessionId，避免把自己踢下线 */
  async revokeOthers(userId: string, currentSessionId: string): Promise<void> {
    await this.sessions.deleteOthers(userId, currentSessionId);
  }
}
