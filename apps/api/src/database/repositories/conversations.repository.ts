/**
 * conversations 表仓储：只负责 SQL，不含业务规则。
 *
 * 隔离边界：
 * - 对话是「私有」的：比组织更细一层，所以除了 org_id（多租户的硬边界，去掉就会跨组织读数据），
 *   还必须带 user_id——同组织里的同事也不该看到别人的会话
 * - findOwned / findOwnedById / list / delete 都把这些条件写进 WHERE，靠数据库兜底而不是靠调用方自觉
 * - 唯一的例外是 touch：它只碰 updated_at，且处在写消息的热路径上，
 *   归属已由上游 findOwned 校验过，这里再查一遍就是白加一次过滤
 * - 不做「消息怎么排序」「标题从哪来」这类判断，消息归 MessagesRepository
 */
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database.service';

/** 会话行（驼峰，可直接给前端） */
export interface ConversationRow {
  id: string;
  orgId: string;
  kbId: string;
  userId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

/** conversations 表原始行（下划线命名，仅本文件内部使用） */
interface RawConversationRow {
  id: string;
  org_id: string;
  kb_id: string;
  user_id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

function mapConversation(row: RawConversationRow): ConversationRow {
  return {
    id: row.id,
    orgId: row.org_id,
    kbId: row.kb_id,
    userId: row.user_id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

@Injectable()
export class ConversationsRepository {
  constructor(private readonly db: DatabaseService) {}

  /** 新建会话。org_id / kb_id / user_id 三个归属字段由调用方给全，本方法不推导也不校验归属关系 */
  async create(input: {
    orgId: string;
    kbId: string;
    userId: string;
    title: string;
  }): Promise<ConversationRow> {
    const result = await this.db.query<RawConversationRow>(
      `INSERT INTO conversations (org_id, kb_id, user_id, title)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [input.orgId, input.kbId, input.userId, input.title],
    );
    return mapConversation(result.rows[0]);
  }

  /**
   * 取「确实属于这个人、这个库」的会话。
   * 四重条件 id + org_id + kb_id + user_id：org_id 是多租户硬边界，user_id 保证同组织同事也猜不到别人的会话，
   * 任何一条不满足都返回 null，接口层据此报 404 而不是 403，避免泄漏「这个 id 存在」。
   */
  async findOwned(
    orgId: string,
    kbId: string,
    userId: string,
    conversationId: string,
  ): Promise<ConversationRow | null> {
    const result = await this.db.query<RawConversationRow>(
      `SELECT * FROM conversations
       WHERE id = $1 AND org_id = $2 AND kb_id = $3 AND user_id = $4`,
      [conversationId, orgId, kbId, userId],
    );
    return result.rows[0] ? mapConversation(result.rows[0]) : null;
  }

  /**
   * 与 findOwned 同族的归属校验，但不要求 kb_id。
   * 用于「按会话 id 打开历史」这类入口：会话归属已经由 org_id + user_id 锁死，
   * 前端不必再传一次 kbId（传错反而会把合法会话判成不存在）。
   */
  async findOwnedById(
    orgId: string,
    userId: string,
    conversationId: string,
  ): Promise<ConversationRow | null> {
    const result = await this.db.query<RawConversationRow>(
      `SELECT * FROM conversations
       WHERE id = $1 AND org_id = $2 AND user_id = $3`,
      [conversationId, orgId, userId],
    );
    return result.rows[0] ? mapConversation(result.rows[0]) : null;
  }

  /**
   * 列出某人在某知识库下的会话，最近活跃的排最前。
   * org_id + kb_id + user_id 三重过滤缺一不可：去掉 org_id 会跨组织读数据，
   * 去掉 kb_id 会把别的知识库的会话混进当前侧边栏。
   */
  async list(
    orgId: string,
    kbId: string,
    userId: string,
  ): Promise<ConversationRow[]> {
    const result = await this.db.query<RawConversationRow>(
      `SELECT * FROM conversations
       WHERE org_id = $1 AND kb_id = $2 AND user_id = $3
       ORDER BY updated_at DESC`,
      [orgId, kbId, userId],
    );
    return result.rows.map(mapConversation);
  }

  /**
   * 把会话顶到列表最前（只刷新 updated_at）。
   * 刻意只按 id 定位：调用方在此之前已经用 findOwned 确认过归属，
   * 这里再带上三重条件是多余的往返开销，热路径上每发一条消息都会走一次。
   */
  async touch(conversationId: string): Promise<void> {
    await this.db.query(
      'UPDATE conversations SET updated_at = now() WHERE id = $1',
      [conversationId],
    );
  }

  /** 删除会话。org_id + user_id 双条件兜底：去掉就会跨组织删数据，去掉 user_id 则能删掉同组织同事的会话 */
  async delete(orgId: string, userId: string, conversationId: string): Promise<void> {
    await this.db.query(
      'DELETE FROM conversations WHERE id = $1 AND org_id = $2 AND user_id = $3',
      [conversationId, orgId, userId],
    );
  }
}
