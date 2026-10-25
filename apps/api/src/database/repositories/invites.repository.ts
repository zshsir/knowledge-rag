/**
 * invites 表仓储：只负责 SQL，不含业务规则。
 *
 * 隔离边界：
 * - 邀请是有租户归属的：list / delete 都带 org_id 条件，org_id 条件是多租户的硬边界，去掉就会跨组织读数据
 *   （delete 少一个 org_id，A 组织的管理员就能凭 id 删掉 B 组织的邀请）
 * - 两处刻意不带 org_id：
 *   findByHash——被邀请人此刻还不是任何组织的成员，无从提供 org_id，
 *   能拿到 token_hash 本身就是全部凭据，组织是从行里读出来的结果而不是过滤条件；
 *   markAccepted——只按 id 定位，调用方必须先由 findByHash 验过票（见方法注释；当前无调用方）
 * - 不生成令牌、不算有效期、不判断邀请是否已用过，那些属于 organizations 模块的邀请服务
 */
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database.service';

/** 按令牌摘要查出来的邀请全貌（带组织名，用于接受前的确认页展示） */
export interface InviteRecord {
  id: string;
  orgId: string;
  orgName: string;
  role: 'admin' | 'member';
  expiresAt: string;
  acceptedAt: string | null;
  kbId: string | null;
  kbPermission: 'viewer' | 'editor' | 'manager' | null;
}

/** 邀请管理列表用的一行（不含令牌摘要，也不暴露给非组织成员） */
export interface InviteView {
  id: string;
  role: 'admin' | 'member';
  createdBy: string | null;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
}

@Injectable()
export class InvitesRepository {
  constructor(private readonly db: DatabaseService) {}

  /**
   * 落一条邀请并返回 id。
   * kbId / kbPermission 为空表示「组织级邀请」，非空表示「只授某一个知识库权限」，两者在这里统一成可空列，
   * 由调用方传 null 而不是省略字段，保证写入语义明确。
   */
  async create(input: {
    orgId: string;
    tokenHash: string;
    role: 'admin' | 'member';
    createdBy: string;
    expiresAt: Date;
    kbId?: string;
    kbPermission?: 'viewer' | 'editor' | 'manager';
  }): Promise<string> {
    const result = await this.db.query<{ id: string }>(
      `INSERT INTO invites (org_id, token_hash, role, created_by, expires_at, kb_id, kb_permission)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        input.orgId,
        input.tokenHash,
        input.role,
        input.createdBy,
        input.expiresAt,
        input.kbId ?? null,
        input.kbPermission ?? null,
      ],
    );
    return result.rows[0].id;
  }

  /**
   * 列出某组织发出的全部邀请，最新的在前。
   * WHERE org_id = $1 是硬边界：少了它，任何一个组织的管理员打开邀请列表就能看到全平台所有邀请链接。
   * SELECT 列表刻意不含 token_hash：列表页不需要、也不该拿到可用的邀请令牌。
   */
  async list(orgId: string): Promise<InviteView[]> {
    const result = await this.db.query<{
      id: string;
      role: 'admin' | 'member';
      created_by: string | null;
      expires_at: string;
      accepted_at: string | null;
      created_at: string;
    }>(
      `SELECT id, role, created_by, expires_at, accepted_at, created_at
       FROM invites WHERE org_id = $1 ORDER BY created_at DESC`,
      [orgId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      role: row.role,
      createdBy: row.created_by,
      expiresAt: row.expires_at,
      acceptedAt: row.accepted_at,
      createdAt: row.created_at,
    }));
  }

  /**
   * 用令牌摘要换出邀请详情。
   * 步骤：
   * 1. 按 token_hash 等值命中：库里只存摘要，所以调用方必须先用原始令牌算出摘要才能查到，这一步等价于验票
   * 2. JOIN organizations 把组织名一起带出，供确认页显示「你将要加入 XXX」，避免用户盲提权
   * 3. 这里不过滤 expires_at / accepted_at：把「是否过期、是否已被使用」留给服务层判断，
   *    这样同一个查询既能用于接受，也能用于展示失败原因
   */
  async findByHash(tokenHash: string): Promise<InviteRecord | null> {
    const result = await this.db.query<{
      id: string;
      org_id: string;
      org_name: string;
      role: 'admin' | 'member';
      expires_at: string;
      accepted_at: string | null;
      kb_id: string | null;
      kb_permission: 'viewer' | 'editor' | 'manager' | null;
    }>(
      `SELECT i.id, i.org_id, o.name AS org_name, i.role, i.expires_at, i.accepted_at,
              i.kb_id, i.kb_permission
       FROM invites i JOIN organizations o ON o.id = i.org_id
       WHERE i.token_hash = $1`,
      [tokenHash],
    );
    const row = result.rows[0];
    return row
      ? {
          id: row.id,
          orgId: row.org_id,
          orgName: row.org_name,
          role: row.role,
          expiresAt: row.expires_at,
          acceptedAt: row.accepted_at,
          kbId: row.kb_id,
          kbPermission: row.kb_permission,
        }
      : null;
  }

  /**
   * 标记邀请已被某人使用：accepted_at 非空即视为已消耗，「一个邀请只能用一次」的强制在服务层。
   * 只按 id 定位，前提是调用方已用 findByHash 验过票——本方法不做 org_id 复核。
   * 当前无调用方：organizations/invites.service 的 accept 在 withTransaction 里自己写了同一条 UPDATE
   * （它需要先 SELECT ... FOR UPDATE 锁住邀请行再连着写 memberships / knowledge_base_members，
   * 而本方法用连接池单发 SQL，进不去那个事务）。两边是同一份 SQL 的两份副本，改表结构时会漂移。
   */
  async markAccepted(inviteId: string, userId: string): Promise<void> {
    await this.db.query(
      'UPDATE invites SET accepted_at = now(), accepted_by = $1 WHERE id = $2',
      [userId, inviteId],
    );
  }

  /** 撤销邀请。WHERE 同时要求 id 和 org_id：org_id 条件是多租户的硬边界，去掉就会跨组织删数据 */
  async delete(orgId: string, inviteId: string): Promise<void> {
    await this.db.query('DELETE FROM invites WHERE id = $1 AND org_id = $2', [
      inviteId,
      orgId,
    ]);
  }
}
