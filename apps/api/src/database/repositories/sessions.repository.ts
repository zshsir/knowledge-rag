/**
 * sessions 表仓储：只负责 SQL，不含业务规则。
 *
 * 隔离边界：
 * - 会话属于「个人」而非「组织」，所以这里的 WHERE 条件不带 org_id，而是 token_hash / user_id
 * - token_hash 是令牌摘要，等值命中即等价于持有令牌；因此本表任何一行泄漏都不能反推出原始令牌
 * - 过期判断统一用 SQL 的 expires_at > now()，把时钟交给数据库，避免多实例之间因本机时间差产生分歧
 * - 不做「该不该允许登录」的判断，也不写 cookie，那些属于 auth 模块
 */
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database.service';
import { AuthUser } from '../../common/types';

/** findValidByTokenHash 的原始行：一次 JOIN 就取到会话加用户，省去再查 users 的往返 */
interface ValidSessionRow {
  session_id: string;
  id: string;
  email: string;
  name: string;
}

@Injectable()
export class SessionsRepository {
  constructor(private readonly db: DatabaseService) {}

  /** 新建会话并返回会话 id。expiresAt 由调用方按 SESSION_TTL_DAYS 算好，本方法不理解有效期规则 */
  async create(userId: string, tokenHash: string, expiresAt: Date): Promise<string> {
    const result = await this.db.query<{ id: string }>(
      `INSERT INTO sessions (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3) RETURNING id`,
      [userId, tokenHash, expiresAt],
    );
    return result.rows[0].id;
  }

  /**
   * 用令牌摘要换出「仍然有效」的会话及其用户。
   * 步骤：
   * 1. 按 token_hash 等值命中，未命中说明令牌伪造或已删除
   * 2. expires_at > now() 过滤掉过期会话，过期与不存在返回同样的 null，不泄漏「曾经存在过」的信息
   */
  async findValidByTokenHash(
    tokenHash: string,
  ): Promise<{ sessionId: string; user: AuthUser } | null> {
    const result = await this.db.query<ValidSessionRow>(
      `SELECT s.id AS session_id, u.id, u.email, u.name
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [tokenHash],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      sessionId: row.session_id,
      // 只挑出 AuthUser 需要的三个字段，password_hash 不在 SELECT 列表里，天然带不出来
      user: { id: row.id, email: row.email, name: row.name },
    };
  }

  /**
   * 刷新「最后使用时间」：只写 last_used_at 这一个字段。
   * 它不参与有效期判定——expires_at 在 create 时一次算死，本方法不延长，全表也没有任何
   * 续期 UPDATE，所以不存在滑动续期（详见 session.service.ts 文件头）。仅用于审计/排查闲置。
   */
  async touch(sessionId: string): Promise<void> {
    await this.db.query('UPDATE sessions SET last_used_at = now() WHERE id = $1', [
      sessionId,
    ]);
  }

  /** 按会话 id 删除（登出当前设备） */
  async deleteById(sessionId: string): Promise<void> {
    await this.db.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
  }

  /**
   * 按令牌摘要删除会话。
   * 与 deleteById 是同一件事的两种入参：手上只有原始 cookie（算不出会话 id）时用这条。
   * 当前无调用方：登出与改口令踢其他设备走的都是 deleteById / deleteOthers，
   * 别把它当成「登出已按令牌兜底」的既有覆盖，需要时得自己接上。
   */
  async deleteByTokenHash(tokenHash: string): Promise<void> {
    await this.db.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
  }

  /**
   * 删除该用户除当前会话外的所有会话，实现「改密码后踢掉其他设备」。
   * id <> $2 是刻意保留当前会话的：否则用户改完密码自己也会立刻掉线。
   */
  async deleteOthers(userId: string, currentSessionId: string): Promise<void> {
    await this.db.query(
      'DELETE FROM sessions WHERE user_id = $1 AND id <> $2',
      [userId, currentSessionId],
    );
  }
}
