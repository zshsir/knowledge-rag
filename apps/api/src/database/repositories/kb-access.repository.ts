/**
 * 知识库权限判定仓储：只负责 SQL，不含业务规则。
 *
 * 它是权限守卫的取数后端，回答三个问题：你是这个组织的什么角色？这个知识库是什么开放模式？
 * 你有没有被单独授权？「三者怎么合成最终权限」的逻辑在 KbAccessService，不在这里。
 *
 * 隔离边界：
 * - getOrgRole / getKb 都带 org_id 条件：org_id 条件是多租户的硬边界，去掉就会跨组织读数据
 *   （getKb 尤其关键，去掉 org_id 就能凭 kbId 读到别的组织的知识库元信息）
 * - getMemberPermission 不带 org_id，因为 kbId 全局唯一且已通过 getKb 校验过归属，
 *   再加一次 org_id 只是重复过滤，不会扩大也不会收窄可见范围
 */
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database.service';
import { KbPermission, OrgRole } from '../../common/types';

/** knowledge_bases 表的安全视图（字段已转驼峰，可直接给前端） */
export interface KbRow {
  id: string;
  orgId: string;
  name: string;
  description: string;
  accessMode: 'org' | 'restricted';
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class KbAccessRepository {
  constructor(private readonly db: DatabaseService) {}

  /** 取组织角色；返回 null 表示此人根本不在这个组织，守卫据此拒绝整个请求 */
  async getOrgRole(orgId: string, userId: string): Promise<OrgRole | null> {
    const result = await this.db.query<{ role: OrgRole }>(
      'SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2',
      [orgId, userId],
    );
    return result.rows[0]?.role ?? null;
  }

  /**
   * 按 (kbId, orgId) 双条件取知识库。
   * 这是跨租户读取的最后一道闸：WHERE 里 org_id 与 id 是 AND 关系，
   * 拿别人的 kbId 配上自己的 orgId 只会得到 null，看起来就像「知识库不存在」。
   */
  async getKb(orgId: string, kbId: string): Promise<KbRow | null> {
    const result = await this.db.query<{
      id: string;
      org_id: string;
      name: string;
      description: string;
      access_mode: 'org' | 'restricted';
      created_by: string | null;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, org_id, name, description, access_mode, created_by, created_at, updated_at
       FROM knowledge_bases WHERE id = $1 AND org_id = $2`,
      [kbId, orgId],
    );
    const row = result.rows[0];
    return row
      ? {
          id: row.id,
          orgId: row.org_id,
          name: row.name,
          description: row.description,
          accessMode: row.access_mode,
          createdBy: row.created_by,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }
      : null;
  }

  /** 取此人对该知识库的显式授权（knowledge_base_members 里的一行）；null 表示没被单独加过，走继承规则 */
  async getMemberPermission(
    kbId: string,
    userId: string,
  ): Promise<KbPermission | null> {
    const result = await this.db.query<{ permission: KbPermission }>(
      'SELECT permission FROM knowledge_base_members WHERE kb_id = $1 AND user_id = $2',
      [kbId, userId],
    );
    return result.rows[0]?.permission ?? null;
  }
}
