/**
 * users 表仓储：只负责 SQL，不含业务规则。
 *
 * 隔离边界：
 * - users 是全局表，本身没有 org_id——同一个邮箱属于同一个人，跨组织复用同一账号是有意设计
 * - 因此这里的查询不带 org_id 条件，真正的多租户隔离发生在 memberships 表（见 memberships.repository.ts）
 * - 也不做权限判断、不做口令校验、不抛 401/403，找不到就返回 null 让调用方决定
 */
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database.service';
import { AuthUser } from '../../common/types';

/** users 表原始行（含口令哈希，只在认证内部流转，绝不能直接序列化给前端） */
export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  name: string;
}

@Injectable()
export class UsersRepository {
  constructor(private readonly db: DatabaseService) {}

  /**
   * 按邮箱精确取用户（含 password_hash，登录时需要它做 bcrypt 比对）。
   * 两边都 lower()：邮箱大小写不敏感是用户预期，否则注册用 A@x.com、登录用 a@x.com 会查不到。
   */
  async findByEmail(email: string): Promise<UserRow | null> {
    const result = await this.db.query<UserRow>(
      'SELECT id, email, password_hash, name FROM users WHERE lower(email) = lower($1)',
      [email],
    );
    return result.rows[0] ?? null;
  }

  /**
   * 按 id 取「对外安全」的用户信息：SELECT 列表刻意不含 password_hash，
   * 从取数层面杜绝把哈希带进接口响应。
   * 注意请求级鉴权不走这里，而是走 SessionsRepository.findValidByTokenHash（它自带 JOIN users，省一次往返）。
   */
  async findById(id: string): Promise<AuthUser | null> {
    const result = await this.db.query<AuthUser>(
      'SELECT id, email, name FROM users WHERE id = $1',
      [id],
    );
    return result.rows[0] ?? null;
  }

  /** 按 id 取含 password_hash 的行，仅用于「改密码」时校验旧口令；其他场景请用 findById */
  async findByIdWithPassword(id: string): Promise<UserRow | null> {
    const result = await this.db.query<UserRow>(
      'SELECT id, email, password_hash, name FROM users WHERE id = $1',
      [id],
    );
    return result.rows[0] ?? null;
  }

  /** 覆盖口令哈希并刷新 updated_at。写入的必须是调用方算好的 bcrypt 哈希，本方法不做任何加密 */
  async updatePasswordHash(userId: string, passwordHash: string): Promise<void> {
    await this.db.query(
      'UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2',
      [passwordHash, userId],
    );
  }
}
