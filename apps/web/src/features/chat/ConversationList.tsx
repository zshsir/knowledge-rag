/**
 * 桌面端会话侧栏：新建、切换、删除入口。
 *
 * 边界：纯展示组件，不发请求也不弹确认框——数据与 mutation 都在 ChatPage，
 * 删除按钮只把会话对象交给 onDelete，由父组件打开 ConfirmDialog 并调接口。
 * 「仅你自己可见」是准确的：后端列表 SQL 按 org_id + kb_id + user_id 三重过滤。
 * 流式生成期间（disabled）三个入口统一禁用，避免切换会话打断在途回答。
 */
import { MessageSquare, Plus, Trash2 } from 'lucide-react';
import type { Conversation } from '../../lib/types';
import { timeAgo } from '../../lib/format';
import { cn } from '../../lib/cn';

/**
 * 会话列表。
 * 步骤：
 * 1. 头部展示标题与新建按钮
 * 2. 列表逐条渲染：当前会话高亮；点击切换；hover 时才露出删除按钮
 * 3. 空列表显示引导与「开始第一段对话」
 */
export function ConversationList({
  conversations,
  activeId,
  disabled,
  onSelect,
  onNew,
  onDelete,
}: {
  conversations: Conversation[];
  activeId: string | null;
  disabled?: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (conversation: Conversation) => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-line px-4 py-3.5">
        <div>
          <p className="text-sm font-semibold text-ink">会话</p>
          <p className="mt-0.5 text-[11px] text-soft">仅你自己可见</p>
        </div>
        <button
          type="button"
          onClick={onNew}
          disabled={disabled}
          className="rounded-lg p-1.5 text-muted transition hover:bg-stone-100 hover:text-ink disabled:opacity-40"
          aria-label="新建对话"
          title="新建对话"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 space-y-0.5 overflow-y-auto p-2">
        {conversations.length ? (
          conversations.map((conversation) => {
            // 当前打开的会话高亮；删除按钮平时 opacity-0，靠父级 group-hover 显形，避免列表过于拥挤
            const active = conversation.id === activeId;
            return (
              <div
                key={conversation.id}
                className={cn(
                  'group relative rounded-lg transition',
                  active ? 'bg-accent-soft/80' : 'hover:bg-stone-50',
                )}
              >
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onSelect(conversation.id)}
                  className="flex w-full items-start gap-2 px-2.5 py-2 pr-8 text-left outline-none disabled:opacity-60"
                >
                  <MessageSquare
                    className={cn(
                      'mt-0.5 h-3.5 w-3.5 shrink-0',
                      active ? 'text-accent' : 'text-soft',
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        'block truncate text-xs font-medium',
                        active ? 'text-indigo-900' : 'text-ink',
                      )}
                    >
                      {conversation.title}
                    </span>
                    <span className="mt-0.5 block text-[10px] text-soft">
                      {timeAgo(conversation.updatedAt)}
                    </span>
                  </span>
                </button>
                {/* 删除按钮绝对定位在行右上角；disabled 时连同 hover 一起隐藏（disabled:hidden） */}
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onDelete(conversation)}
                  className="absolute right-1.5 top-2 rounded-md p-1 text-soft opacity-0 transition hover:bg-white hover:text-red-600 group-hover:opacity-100 disabled:hidden"
                  aria-label="删除会话"
                  title="删除会话"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })
        ) : (
          <div className="px-3 py-8 text-center">
            <MessageSquare className="mx-auto h-5 w-5 text-soft/70" />
            <p className="mt-2 text-xs text-soft">还没有会话</p>
            <button
              type="button"
              disabled={disabled}
              onClick={onNew}
              className="mt-2 text-xs font-medium text-accent disabled:opacity-50"
            >
              开始第一段对话
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
