/**
 * knowledge_bases 表仓储：只负责 SQL，不含业务规则。
 *
 * 隔离边界：
 * - 除了按 kb_id 定位之外，每条语句都带 org_id 条件：org_id 条件是多租户的硬边界，
 *   去掉就会跨组织读写数据；delete / update 少了它甚至会改到别人的库
 * - listForOrg 把「谁能看见哪些库」的可见性规则直接下推到 SQL 的 WHERE 里，
 *   这样列表只有一次查询、也不会出现「先查全量再在内存里筛」时漏筛的情况
 * - 不判断 access_mode 变更是否该发通知、不级联删文档（级联交给外键 ON DELETE CASCADE）
 */
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database.service';
import { KbPermission, OrgRole } from '../../common/types';
import { KbRow } from './kb-access.repository';

/** 列表项 = 知识库本体 + 当前用户的显式权限 + 两个统计数 */
export interface KnowledgeBaseListItem extends KbRow {
  explicitPermission: KbPermission | null;
  documentCount: number;
  memberCount: number;
}

/** 列表查询的原始行（下划线命名，仅本文件内部使用） */
interface RawKbListRow {
  id: string;
  org_id: string;
  name: string;
  description: string;
  access_mode: 'org' | 'restricted';
  created_by: string | null;
  created_at: string;
  updated_at: string;
  explicit_permission: KbPermission | null;
  document_count: number;
  member_count: number;
}

/**
 * 下划线列名 -> 驼峰 KbRow。
 * 抽成函数是因为知识库查询有四处（列表/创建/查详情/更新），返回的都是同一组列，
 * 集中一处转换才能保证字段名与类型不会各写各的。
 */
function mapKb(row: {
  id: string;
  org_id: string;
  name: string;
  description: string;
  access_mode: 'org' | 'restricted';
  created_by: string | null;
  created_at: string;
  updated_at: string;
}): KbRow {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    description: row.description,
    accessMode: row.access_mode,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

@Injectable()
export class KnowledgeBasesRepository {
  constructor(private readonly db: DatabaseService) {}

  /**
   * 列出某用户在某组织里看得见的知识库，并带上统计信息。
   *
   * 步骤：
   * 1. WHERE kb.org_id = $1 划定租户边界——硬边界，去掉就会跨组织读数据
   * 2. LEFT JOIN knowledge_base_members 取「当前用户的显式授权」，没被授权过也是合法结果（permission 为 NULL）
   *    用 LEFT JOIN 而不是 INNER：大部分库靠组织模式开放，根本不存在授权行，内连接会把它们全部漏掉
   * 3. 可见性四选一（命中任一即可见），与 KbAccessService.resolve 的四条判定一一对应：
   *    - 组织 owner/admin：管理员看全量
   *    - access_mode='org'：组织开放模式的库对全员可见
   *    - created_by=本人：自己建的库永远看得见，即使切成了 restricted
   *    - 有显式授权行：被单独加进来的人
   * 4. 文档数与成员数用相关子查询现算：列表页只要展示数量，取回全部子行代价太大
   * 5. 按创建时间倒序，新建的库排在最前
   */
  async listForOrg(
    orgId: string,
    userId: string,
    orgRole: OrgRole,
  ): Promise<KnowledgeBaseListItem[]> {
    const result = await this.db.query<RawKbListRow>(
      `SELECT kb.id, kb.org_id, kb.name, kb.description, kb.access_mode,
              kb.created_by, kb.created_at, kb.updated_at,
              km.permission AS explicit_permission,
              (SELECT count(*)::int FROM documents d WHERE d.kb_id = kb.id) AS document_count,
              (SELECT count(*)::int FROM knowledge_base_members m2 WHERE m2.kb_id = kb.id) AS member_count
       FROM knowledge_bases kb
       LEFT JOIN knowledge_base_members km ON km.kb_id = kb.id AND km.user_id = $2
       WHERE kb.org_id = $1
         AND ($3 IN ('owner', 'admin')
              OR kb.access_mode = 'org'
              OR kb.created_by = $2
              OR km.permission IS NOT NULL)
       ORDER BY kb.created_at DESC`,
      [orgId, userId, orgRole],
    );
    return result.rows.map((row) => ({
      ...mapKb(row),
      explicitPermission: row.explicit_permission,
      documentCount: row.document_count,
      memberCount: row.member_count,
    }));
  }

  /**
   * 新建知识库并回读整行。
   * id 在应用层用 randomUUID 生成再插入（而不是靠数据库默认值），是为了插入前就拿到 id，
   * 便于同一请求里紧接着写授权行或日志。RETURNING 取回 created_at 等由数据库填的字段。
   */
  async create(input: {
    orgId: string;
    name: string;
    description: string;
    accessMode: 'org' | 'restricted';
    createdBy: string;
  }): Promise<KbRow> {
    const id = randomUUID();
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
      `INSERT INTO knowledge_bases (id, org_id, name, description, access_mode, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, org_id, name, description, access_mode, created_by, created_at, updated_at`,
      [id, input.orgId, input.name, input.description, input.accessMode, input.createdBy],
    );
    return mapKb(result.rows[0]);
  }

  /**
   * 按 (kbId, orgId) 双条件取库。
   * org_id 条件是多租户的硬边界，去掉就会凭 kb_id 读到别的组织的知识库；
   * 跨组织命中不到时返回 null，服务层一律当「不存在」处理，不区分「存在但无权」。
   */
  async findById(orgId: string, kbId: string): Promise<KbRow | null> {
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
    return result.rows[0] ? mapKb(result.rows[0]) : null;
  }

  /**
   * 更新库信息。
   * WHERE 里的 org_id 是硬边界，去掉就能改到别的组织的库。
   * 这里假设调用方已确认该库存在（服务层先 findById 校验过），所以直接取 rows[0]。
   */
  async update(
    orgId: string,
    kbId: string,
    input: { name: string; description: string; accessMode: 'org' | 'restricted' },
  ): Promise<KbRow> {
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
      `UPDATE knowledge_bases
       SET name = $1, description = $2, access_mode = $3, updated_at = now()
       WHERE id = $4 AND org_id = $5
       RETURNING id, org_id, name, description, access_mode, created_by, created_at, updated_at`,
      [input.name, input.description, input.accessMode, kbId, orgId],
    );
    return mapKb(result.rows[0]);
  }

  /**
   * 删除知识库。
   * org_id 条件是多租户的硬边界，去掉就能凭 id 删掉别人的库。
   * 文档、切片、成员授权行都带 REFERENCES ... ON DELETE CASCADE，由数据库一并清理，这里不写级联 SQL。
   */
  async delete(orgId: string, kbId: string): Promise<void> {
    await this.db.query(
      'DELETE FROM knowledge_bases WHERE id = $1 AND org_id = $2',
      [kbId, orgId],
    );
  }

  /**
   * 算出「若把这个库改为 restricted，会立刻失去访问权」的用户列表，用于改权限模式前的提示。
   *
   * 步骤：
   * 1. 只看本组织的普通 member：owner/admin 靠组织角色始终是 manager，不受模式影响
   * 2. 排除创建者：创建者即使切成 restricted 也仍然看得见自己的库
   * 3. NOT EXISTS 排除已有显式授权的人：他们在授权表里，切模式不影响
   * 4. 三条都成立才是「真正会被挡在门外」的人
   *
   * 边界：created_by 为 NULL 时（系统建库或历史数据），子查询返回 NULL，
   * `m.user_id <> NULL` 既不真也不假，整条谓词永远不成立——受影响集合为空，
   * 于是改模式时一个回收事件都不会发。要让这类库也发事件，条件需写成
   * `(SELECT created_by ...) IS NULL OR m.user_id <> (SELECT created_by ...)`。
   */
  async affectedByRestriction(orgId: string, kbId: string): Promise<string[]> {
    const result = await this.db.query<{ user_id: string }>(
      `SELECT m.user_id
       FROM memberships m
       WHERE m.org_id = $1
         AND m.role = 'member'
         AND m.user_id <> (SELECT created_by FROM knowledge_bases WHERE id = $2)
         AND NOT EXISTS (
           SELECT 1 FROM knowledge_base_members km
           WHERE km.kb_id = $2 AND km.user_id = m.user_id
         )`,
      [orgId, kbId],
    );
    return result.rows.map((row) => row.user_id);
  }
}
