/**
 * messages 表仓储：只负责 SQL，不含业务规则。
 *
 * 隔离边界：
 * - messages 表本身没有 org_id 列：消息只属于会话，租户与个人边界由 conversations 承载
 *   （org_id 条件在多租户的硬边界那一层生效，见 ConversationsRepository）
 * - 所以本仓储每个方法都要求先传入 conversationId，调用方必须用 findOwned/findOwnedById 校验过
 *   该会话属于当前用户，再拿这个 id 进来；直接接受前端传来的 conversationId 等于越权读别人的对话
 * - 不拼提示词、不调模型、不做引用编号，只负责把消息存取回来
 */
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database.service';
import { ChatMessage } from '../../llm/llm.types';
import { Source } from '../../chat/sources';

/** 消息行（驼峰，可直接给前端渲染气泡与引用卡片） */
export interface MessageRow {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  sources: Source[] | null;
  interrupted: boolean;
  createdAt: string;
}

/** messages 表原始行（下划线命名，仅本文件内部使用） */
interface RawMessageRow {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  /** jsonb 列：pg 驱动已自动反序列化成 JS 数组，无需再 JSON.parse */
  sources: Source[] | null;
  interrupted: boolean;
  created_at: string;
}

function mapMessage(row: RawMessageRow): MessageRow {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    sources: row.sources,
    interrupted: row.interrupted,
    createdAt: row.created_at,
  };
}

@Injectable()
export class MessagesRepository {
  constructor(private readonly db: DatabaseService) {}

  /**
   * 追加一条消息并回读整行。
   * 步骤：
   * 1. sources 是引用来源数组，写入前显式 JSON.stringify 并标成 $4::jsonb——传数组进去 pg 不会自动序列化
   * 2. interrupted 默认 false：只有用户点「停止生成」才置真，前端据此把这条气泡标成「已中断」而不是完整回答
   * 3. RETURNING * 取回数据库生成的 id 和 created_at，调用方需要它们做后续 touch / 流式对齐
   */
  async insert(input: {
    conversationId: string;
    role: 'user' | 'assistant';
    content: string;
    sources?: Source[] | null;
    interrupted?: boolean;
  }): Promise<MessageRow> {
    const result = await this.db.query<RawMessageRow>(
      `INSERT INTO messages (conversation_id, role, content, sources, interrupted)
       VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING *`,
      [
        input.conversationId,
        input.role,
        input.content,
        input.sources ? JSON.stringify(input.sources) : null,
        input.interrupted ?? false,
      ],
    );
    return mapMessage(result.rows[0]);
  }

  /**
   * 取最近若干条消息，作为多轮对话的历史塞进提示词。
   *
   * 步骤：
   * 1. 内层按 created_at DESC, id DESC 取最新的 limit 条——先倒序才能「取最近 N 条」而不是最老的 N 条
   * 2. ORDER BY 里补 id DESC 是为了同一时刻写入的消息也有确定顺序，否则每次取到的窗口可能不同
   * 3. 外层再按 created_at ASC 转回正序：提示词必须按时间从旧到新，模型才能理解对话顺序
   * 4. 只取 role 和 content：这一路是给模型当上下文用的，id / sources 反而会增加 token 与干扰
   */
  async recent(
    conversationId: string,
    limit: number,
  ): Promise<ChatMessage[]> {
    const result = await this.db.query<{
      role: 'user' | 'assistant';
      content: string;
    }>(
      `SELECT role, content FROM (
         SELECT role, content, created_at FROM messages
         WHERE conversation_id = $1
         ORDER BY created_at DESC, id DESC
         LIMIT $2
       ) recent
       ORDER BY created_at ASC`,
      [conversationId, limit],
    );
    return result.rows;
  }

  /**
   * 取某会话的完整历史（含引用来源），按时间正序，供前端回放。
   * 与 recent 的区别是用途：这个要给用户看全量记录，所以要带上 id / sources / interrupted。
   */
  async list(conversationId: string): Promise<MessageRow[]> {
    const result = await this.db.query<RawMessageRow>(
      `SELECT * FROM messages WHERE conversation_id = $1
       ORDER BY created_at ASC, id ASC`,
      [conversationId],
    );
    return result.rows.map(mapMessage);
  }
}
