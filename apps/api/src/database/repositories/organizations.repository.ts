/**
 * organizations 表仓储：只负责 SQL，不含业务规则。
 *
 * 隔离边界：
 * - org 本身就是多租户的租户单位，所以这里的「硬边界」是 organizations.id：
 *   任何按 id 的读写都只可能命中该组织自己那一行，去掉 id 条件就会跨组织改数据
 * - listForUser 用 memberships.user_id 反向限定，用户只能看见自己加入过的组织
 * - 不判断调用者是不是 owner/admin，权限判断属于 organizations / auth 模块的服务层
 */
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database.service';
import { OrgSummary } from '../../common/types';

@Injectable()
export class OrganizationsRepository {
  constructor(private readonly db: DatabaseService) {}

  /**
   * 列出某用户属于哪些组织，并带上他在每个组织里的角色。
   * 步骤：
   * 1. 从 memberships 反向找（m.user_id = $1），没加入的组织一律不出现
   * 2. role 直接取成员表里的角色，一个组织一行，避免再发一次查询
   * 3. 按创建时间升序：先注册的组织排在前面，切换器顺序稳定不随登录漂移
   */
  async listForUser(userId: string): Promise<OrgSummary[]> {
    const result = await this.db.query<OrgSummary>(
      `SELECT o.id, o.name, m.role
       FROM organizations o
       JOIN memberships m ON m.org_id = o.id
       WHERE m.user_id = $1
       ORDER BY o.created_at ASC`,
      [userId],
    );
    return result.rows;
  }

  /** 按组织 id 取名字。调用方必须先确认请求者是该组织成员——本方法只保证「不会读到别人的组织」，不保证「读的人有资格」 */
  async findById(orgId: string): Promise<{ id: string; name: string } | null> {
    const result = await this.db.query<{ id: string; name: string }>(
      'SELECT id, name FROM organizations WHERE id = $1',
      [orgId],
    );
    return result.rows[0] ?? null;
  }

  /** 重命名组织并刷新 updated_at。WHERE 只带 org_id，一次调用不可能改到别的组织 */
  async rename(orgId: string, name: string): Promise<void> {
    await this.db.query(
      'UPDATE organizations SET name = $1, updated_at = now() WHERE id = $2',
      [name, orgId],
    );
  }
}
