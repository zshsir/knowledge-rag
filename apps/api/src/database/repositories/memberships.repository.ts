/**
 * memberships 表仓储：只负责 SQL，不含业务规则。
 *
 * 隔离边界：
 * - 这张表就是「用户 ↔ 组织」的租户归属关系表，是全系统多租户隔离的根
 * - 除 create 外每个方法都以 org_id 作为 WHERE 条件：org_id 条件是多租户的硬边界，去掉就会跨组织读数据
 *   （尤其 remove / updateRole，少一个条件就会把别的作用户删掉或提权）
 * - create 是唯一例外：它的 org_id 是写进新行的值而不是过滤条件，隔离靠调用方传对组织，
 *   唯一键 (org_id, user_id) 只保证同一组织里不会重复，不校验传进来的 org_id 是否合法
 * - 不校验「操作者有没有资格改别人的角色」，那属于 organizations 模块的服务层
 */
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database.service';
import { OrgRole } from '../../common/types';

/** 一条成员关系的最小视图（下划线列名已转成驼峰） */
export interface Membership {
  orgId: string;
  userId: string;
  role: OrgRole;
}

/** 给前端成员列表用的视图：成员关系加上用户基本信息 */
export interface OrgMemberView {
  id: string;
  name: string;
  email: string;
  role: OrgRole;
  joinedAt: string;
}

@Injectable()
export class MembershipsRepository {
  constructor(private readonly db: DatabaseService) {}

  /** 查某人在某组织的成员关系（不存在返回 null）。org_id + user_id 双条件，取数不可能命中其他组织的同名成员行 */
  async find(orgId: string, userId: string): Promise<Membership | null> {
    const result = await this.db.query<{
      org_id: string;
      user_id: string;
      role: OrgRole;
    }>(
      'SELECT org_id, user_id, role FROM memberships WHERE org_id = $1 AND user_id = $2',
      [orgId, userId],
    );
    const row = result.rows[0];
    return row ? { orgId: row.org_id, userId: row.user_id, role: row.role } : null;
  }

  /**
   * 列出某组织的全体成员。
   * 步骤：
   * 1. WHERE m.org_id = $1 是硬边界，去掉就会把全平台用户列出来
   * 2. ORDER BY 用 CASE 把 owner 排最前、admin 其次、普通成员最后，让权限最高的人始终在列表顶部
   * 3. 同角色内按名字升序，保证分页前的顺序稳定可复现
   */
  async list(orgId: string): Promise<OrgMemberView[]> {
    const result = await this.db.query<{
      id: string;
      name: string;
      email: string;
      role: OrgRole;
      joined_at: string;
    }>(
      `SELECT u.id, u.name, u.email, m.role, m.created_at AS joined_at
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.org_id = $1
       ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
                u.name ASC`,
      [orgId],
    );
    // 数据库返回下划线列名，在这里一次性转成前端用的驼峰，避免脏字段名泄漏到接口层
    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      role: row.role,
      joinedAt: row.joined_at,
    }));
  }

  /** 改某人在指定组织的角色。org_id 条件同时是硬边界：没有它，updateRole 会变成跨组织提权 */
  async updateRole(orgId: string, userId: string, role: OrgRole): Promise<void> {
    await this.db.query(
      'UPDATE memberships SET role = $1, updated_at = now() WHERE org_id = $2 AND user_id = $3',
      [role, orgId, userId],
    );
  }

  /** 移除成员。org_id 条件是硬边界，去掉就会把该用户在所有组织的成员资格一起删掉 */
  async remove(orgId: string, userId: string): Promise<void> {
    await this.db.query(
      'DELETE FROM memberships WHERE org_id = $1 AND user_id = $2',
      [orgId, userId],
    );
  }

  /**
   * 纯存在性判断，只回一个 bool。
   * 和 find 的区别是刻意省下整行字段的取数——调用方只关心「是不是成员」时不该把 role 拖回来。
   * org_id + user_id 双条件，不会把别的组织里的同名成员误判为 true。
   */
  async isMember(orgId: string, userId: string): Promise<boolean> {
    const result = await this.db.query(
      'SELECT 1 FROM memberships WHERE org_id = $1 AND user_id = $2',
      [orgId, userId],
    );
    return Boolean(result.rowCount);
  }

  /**
   * 加成员，重复调用无副作用。
   * ON CONFLICT DO NOTHING 而不是先查再插：调用方通常是「先 isMember 再 create」这种检查后写入的形态，
   * 两个请求可能同时判定「还不是成员」，靠唯一键兜底才不会因主键冲突把整个事务回滚掉。
   */
  async create(orgId: string, userId: string, role: OrgRole = 'member'): Promise<void> {
    await this.db.query(
      `INSERT INTO memberships (org_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [orgId, userId, role],
    );
  }
}
