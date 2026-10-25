/**
 * knowledge_base_members 表仓储：只负责 SQL，不含业务规则。
 *
 * 这张表存「对某个知识库的显式授权」，是权限合成里的最后一层；
 * 「显式授权 + 组织角色 + 创建者身份怎么算出最终权限」属于 KbAccessService，不在这里。
 *
 * 隔离边界：
 * - 本表没有 org_id 列，租户边界由 kb_id 承载：一个知识库唯一归属一个组织，
 *   所以调用方必须先按 (org_id, kb_id) 确认知识库归属（见 KbAccessRepository.getKb），
 *   再拿这个 kb_id 进来，否则就等于绕过了多租户的硬边界
 * - listInherited 例外：它直接按 org_id 查 memberships，org_id 条件是多租户的硬边界，去掉就会跨组织读数据
 * - 不做「谁有权授权给谁」的判断
 */
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database.service';
import { KbPermission } from '../../common/types';

/** 成员列表一行：用户基本信息加显式权限 */
export interface KbMemberView {
  userId: string;
  name: string;
  email: string;
  permission: KbPermission;
  createdAt?: string;
}

/** 权限继承而来的「成员」：不是表里的行，而是靠组织角色/创建者身份推导出来的，界面要单独标出来 */
export interface InheritedKbMemberView extends KbMemberView {
  inherited: true;
  source: string;
}

@Injectable()
export class KbMembersRepository {
  constructor(private readonly db: DatabaseService) {}

  /** 读单条显式授权；null 表示没被单独授予过，需要走继承判断 */
  async get(kbId: string, userId: string): Promise<KbPermission | null> {
    const result = await this.db.query<{ permission: KbPermission }>(
      'SELECT permission FROM knowledge_base_members WHERE kb_id = $1 AND user_id = $2',
      [kbId, userId],
    );
    return result.rows[0]?.permission ?? null;
  }

  /**
   * 列出某知识库的显式成员（真正落在表里的那些行），按名字升序。
   * WHERE km.kb_id = $1 限定了范围，调用方必须保证这个 kb_id 属于请求者所在组织。
   */
  async listExplicit(kbId: string): Promise<KbMemberView[]> {
    const result = await this.db.query<{
      user_id: string;
      name: string;
      email: string;
      permission: KbPermission;
      created_at: string;
    }>(
      `SELECT u.id AS user_id, u.name, u.email, km.permission, km.created_at
       FROM knowledge_base_members km
       JOIN users u ON u.id = km.user_id
       WHERE km.kb_id = $1
       ORDER BY u.name ASC`,
      [kbId],
    );
    return result.rows.map((row) => ({
      userId: row.user_id,
      name: row.name,
      email: row.email,
      permission: row.permission,
      createdAt: row.created_at,
    }));
  }

  /**
   * 列出「没有授权记录但事实上管得住这个库」的人，供界面提示权限来源。
   *
   * 步骤：
   * 1. 第一段 SELECT 取该组织的 owner 和 admin：org_id 条件是多租户的硬边界，去掉就会把别的管理员算进来
   * 2. UNION 第二段取该知识库的创建者：创建者即使不是管理员也天生是 manager
   * 3. 两段都打不同 source 标签（组织所有者/组织管理员/知识库创建者），前端才能解释「这人为什么在这儿」
   * 4. 用 Set 按 user_id 去重：一个人可能同时是 admin 又是创建者，界面只应出现一次
   *    （UNION 本身不去重这一列，因为 source 文本不同）
   * 5. 统一标 permission='manager' 与 inherited=true：提醒他们没在表里，直接删授权行是删不掉其权限的
   */
  async listInherited(orgId: string, kbId: string): Promise<InheritedKbMemberView[]> {
    const result = await this.db.query<{
      user_id: string;
      name: string;
      email: string;
      source: string;
    }>(
      `SELECT DISTINCT u.id AS user_id, u.name, u.email,
              CASE WHEN m.role = 'owner' THEN '组织所有者' ELSE '组织管理员' END AS source
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.org_id = $1 AND m.role IN ('owner', 'admin')
       UNION
       SELECT u.id AS user_id, u.name, u.email, '知识库创建者' AS source
       FROM knowledge_bases kb
       JOIN users u ON u.id = kb.created_by
       WHERE kb.id = $2`,
      [orgId, kbId],
    );
    // 步骤 4：同一个人可能同时命中两段，这里只保证「一个人只出现一次」——留下遍历到的第一行，丢掉后来的
    // 注意整条 SQL 没有 ORDER BY，而 UNION 的行序不属于 SQL 语义（Postgres 也不保证按段先后返回），
    // 所以「组织角色」还是「知识库创建者」哪条 source 被展示不作保证，只是尽力去重
    const seen = new Set<string>();
    return result.rows
      .filter((row) => {
        if (seen.has(row.user_id)) return false;
        seen.add(row.user_id);
        return true;
      })
      .map((row) => ({
        userId: row.user_id,
        name: row.name,
        email: row.email,
        permission: 'manager',
        inherited: true,
        source: row.source,
      }));
  }

  /**
   * 写入或覆盖一条显式授权。
   * 用 ON CONFLICT DO UPDATE 而不是先查再插：同一对用户重复授权时应当是「改权限」而不是报唯一键冲突。
   * grantedBy 一并覆盖，保留最新一次授权是谁给的。
   */
  async upsert(input: {
    kbId: string;
    userId: string;
    permission: KbPermission;
    grantedBy: string;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO knowledge_base_members (kb_id, user_id, permission, granted_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (kb_id, user_id)
       DO UPDATE SET permission = EXCLUDED.permission, granted_by = EXCLUDED.granted_by`,
      [input.kbId, input.userId, input.permission, input.grantedBy],
    );
  }

  /** 撤销显式授权。kb_id + user_id 双条件，不可能误删这个人在其他知识库的权限 */
  async delete(kbId: string, userId: string): Promise<void> {
    await this.db.query(
      'DELETE FROM knowledge_base_members WHERE kb_id = $1 AND user_id = $2',
      [kbId, userId],
    );
  }
}
