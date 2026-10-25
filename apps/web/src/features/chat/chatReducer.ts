/**
 * 单条流式回答的状态机：把 WebSocket 推来的 chat:meta / chat:delta / chat:done / chat:error
 * 收敛成一份可直接渲染的状态（用户问题、已生成文本、引用来源、状态、是否被取消、错误文案）。
 *
 * 边界：
 * - 只描述「当前这一条在途回答」，不保存历史消息——历史在 React Query 的 ['messages', orgId, conversationId]
 *   缓存里；本文件不发请求、不碰 socket、不落库
 * - 「取消」没有独立的 action：用户点停止后由服务端回一条 cancelled=true 的 chat:done，
 *   局部答案因此走 done 分支保留下来，不会被清空（详见 done 分支的注释）
 * - 测试见 chatReducer.spec.ts（delta 累加、done 收尾、跨 requestId 事件丢弃、error 记录）
 */
import type { Source } from '../../lib/types';

export interface ChatStreamState {
  /** 本次请求 id：服务端事件都带同一个 id，不匹配的一律丢弃（start 时由 ChatPage 生成） */
  requestId: string | null;
  /** 服务端在 chat:meta 里给出的会话 id；新对话在第一条 meta 之前为 null */
  conversationId: string | null;
  /** 用户刚发的问题：乐观回显用，done 后由 ChatPage reset 掉（历史消息改从消息查询里读） */
  userText: string;
  /** 到目前为止累计的助手正文，delta 逐段追加；done 时不清空，取消时靠它留住半条答案 */
  assistantText: string;
  /** chat:meta 先带回来的引用片段，生成期间就能展示来源 */
  sources: Source[];
  status: 'idle' | 'streaming' | 'done' | 'error';
  /** 只有服务端 done 事件会置真：用户点停止后，服务端把已生成部分落库并存 interrupted=true */
  cancelled: boolean;
  error: string | null;
}

export const initialChatState: ChatStreamState = {
  requestId: null,
  conversationId: null,
  userText: '',
  assistantText: '',
  sources: [],
  status: 'idle',
  cancelled: false,
  error: null,
};

export type ChatStreamAction =
  | { type: 'start'; requestId: string; userText: string }
  | {
      type: 'meta';
      requestId: string;
      conversationId: string;
      sources: Source[];
    }
  | { type: 'delta'; requestId: string; text: string }
  | {
      type: 'done';
      requestId: string;
      conversationId: string;
      cancelled: boolean;
    }
  | { type: 'error'; requestId: string; message: string }
  | { type: 'reset' };

export function chatReducer(
  state: ChatStreamState,
  action: ChatStreamAction,
): ChatStreamState {
  // reset：整体回到初始态。新对话、切换会话、关闭错误提示、done 收尾后都由 ChatPage 派发
  if (action.type === 'reset') return initialChatState;
  // start：开始新请求。先摊掉 initialChatState 再写入问题，确保上一条的正文/来源/错误不会串到这一条
  if (action.type === 'start') {
    return {
      ...initialChatState,
      requestId: action.requestId,
      userText: action.userText,
      status: 'streaming',
    };
  }
  // 闸门：meta/delta/done/error 必须与当前请求 id 一致，否则原样返回。
  // 场景是停止后旧请求的尾包、或快速连发时前一条的迟到事件——不拦就会把内容混进新回答
  if (state.requestId !== action.requestId) return state;

  switch (action.type) {
    // meta 先到：服务端先检索再生成，这里只补会话 id 与来源，不动正文
    case 'meta':
      return {
        ...state,
        conversationId: action.conversationId,
        sources: action.sources,
      };
    // delta 合并：一个 token 一段地按到达顺序往后拼；前端不做去重与重排
    case 'delta':
      return { ...state, assistantText: state.assistantText + action.text };
    // done 收尾：只改状态与取消标记，刻意不清空 assistantText。
    // 取消时（cancelled=true）服务端把已生成部分落库（interrupted=true），半条答案先靠这里继续显示，
    // 随后 ChatPage 先拉取消息缓存再 reset，界面无缝换成历史消息里的同一条
    case 'done':
      return {
        ...state,
        status: 'done',
        conversationId: action.conversationId,
        cancelled: action.cancelled,
      };
    // error：记录原因供气泡展示；已生成的部分正文同样保留（用户可对照后重问）
    case 'error':
      return { ...state, status: 'error', error: action.message };
    default:
      return state;
  }
}
