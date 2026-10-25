/**
 * 对话工作台：当前知识库下的会话列表、历史消息、流式回答与输入框。
 *
 * 数据来源与边界：
 * - 历史消息来自 React Query 的 ['messages', orgId, conversationId]；流式中的这一条来自 chatReducer
 * - 生成走 WebSocket（lib/socket）：chat:send 发起，chat:meta/delta/done/error 推进，
 *   chat:cancel 停止；本页不调 HTTP 生成接口，也不负责入库（服务端在 done 之前已落库）
 * - 不负责知识库/组织切换（KbLayout 提供 useKbContext），不负责登录态（AuthProvider）
 * - 会话按「当前用户 + 当前知识库」隔离：列表接口在后端就带 user_id 过滤，侧栏文案「仅你自己可见」不是前端假象
 */
import {
  useEffect,
  useReducer,
  useRef,
  useState,
} from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  ArrowUp,
  BookOpen,
  ChevronDown,
  Loader2,
  Plus,
  Sparkles,
  Square,
} from 'lucide-react';
import { Avatar } from '../../components/ui/avatar';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { ConfirmDialog } from '../../components/ui/confirm-dialog';
import { EmptyState } from '../../components/ui/empty-state';
import { PageLoader } from '../../components/ui/spinner';
import { useToast } from '../../components/ui/toast';
import { useSocket } from '../../lib/socket';
import { apiFetch, ApiError } from '../../lib/api';
import type {
  ChatDeltaEvent,
  ChatDoneEvent,
  ChatErrorEvent,
  ChatMetaEvent,
  Conversation,
  Message,
  Source,
} from '../../lib/types';
import { formatDate } from '../../lib/format';
import { useAuth } from '../auth/AuthProvider';
import { useKbContext } from '../knowledge-bases/kb-context';
import { chatReducer, initialChatState } from './chatReducer';
import { ConversationList } from './ConversationList';
import { MarkdownText } from './MarkdownText';
import { SourceCard } from './SourceCard';
import { cn } from '../../lib/cn';

/** 空对话页的预置问题：点击后走与手动输入相同的 sendMessage 流程 */
const suggestions = [
  '总结这个知识库的核心内容',
  '有哪些关键流程和注意事项？',
  '根据资料给出下一步行动建议',
];

/** 助手气泡左侧的品牌小图标（纯展示，不参与布局计算） */
function AssistantMark() {
  return (
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-indigo-700 text-white shadow-sm shadow-indigo-900/20">
      <Sparkles className="h-4 w-4" />
    </div>
  );
}

/**
 * 引用来源列表：来源为空时整块不渲染（普通问候/无检索结果的回答就没有这一块）。
 * key 用 chunkId 而不是 index：index 只是本次回答内的引用序号，同一片段可能在两条回答里出现
 */
function Sources({ sources }: { sources: Source[] }) {
  if (!sources.length) return null;
  return (
    <div className="mt-3 space-y-2">
      <p className="text-[11px] font-medium uppercase tracking-wide text-soft">引用来源</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {sources.map((source) => (
          <SourceCard key={source.chunkId} source={source} />
        ))}
      </div>
    </div>
  );
}

/**
 * 一条历史消息：用户消息右对齐、无 Markdown；助手消息左对齐、按 Markdown 渲染并附引用。
 * interrupted 由服务端消息行带出（用户点停止时落库为 true），这里只负责显示「已停止生成」徽标。
 */
function MessageBubble({ message, userName }: { message: Message; userName: string }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end gap-3">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-sidebar px-4 py-2.5 text-sm leading-relaxed text-white shadow-sm">
          <p className="whitespace-pre-wrap">{message.content}</p>
        </div>
        <Avatar name={userName} size="sm" className="mt-0.5" />
      </div>
    );
  }

  return (
    <div className="flex gap-3">
      <AssistantMark />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-ink">Atlas</span>
          {message.interrupted ? <Badge tone="warning">已停止生成</Badge> : null}
          <span className="text-[10px] text-soft">{formatDate(message.createdAt)}</span>
        </div>
        <div className="mt-1.5">
          <MarkdownText content={message.content} />
        </div>
        {message.sources?.length ? <Sources sources={message.sources} /> : null}
      </div>
    </div>
  );
}

/**
 * 空对话引导：知识库名 + 三条预置问题。
 * disabled 由 socket 连接状态决定——未连接时点击没有意义，直接置灰而不是点了才报错。
 */
function WelcomePanel({
  kbName,
  disabled,
  onSuggestion,
}: {
  kbName: string;
  disabled: boolean;
  onSuggestion: (text: string) => void;
}) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center px-2 py-10 text-center">
      <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-indigo-700 text-white shadow-xl shadow-indigo-900/20">
        <Sparkles className="h-6 w-6" />
        <span className="absolute -right-1 -top-1 h-3 w-3 rounded-full bg-emerald-400 ring-2 ring-white" />
      </div>
      <h2 className="mt-5 text-lg font-semibold tracking-tight text-ink">
        向「{kbName}」提问
      </h2>
      <p className="mt-1.5 max-w-md text-sm leading-relaxed text-muted">
        回答会严格基于知识库资料，并标注引用来源。先上传文档，效果会更好。
      </p>
      <div className="mt-6 grid w-full max-w-xl gap-2 sm:grid-cols-3">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            disabled={disabled}
            onClick={() => onSuggestion(suggestion)}
            className="rounded-xl border border-line bg-white px-3 py-3 text-left text-xs leading-relaxed text-muted shadow-sm transition hover:-translate-y-0.5 hover:border-indigo-200 hover:text-ink hover:shadow-md disabled:pointer-events-none disabled:opacity-50"
          >
            {suggestion}
          </button>
        ))}
      </div>
      <p className="mt-6 inline-flex items-center gap-1.5 text-[11px] text-soft">
        <BookOpen className="h-3.5 w-3.5" />
        先在「文档」标签上传资料，再开始对话
      </p>
    </div>
  );
}

/**
 * 对话页主体。
 * 步骤：
 * 1. 拉会话列表（orgId + kbId 维度）与当前会话消息（activeId）；没有当前会话且不在「新对话」时自动选最近一条
 * 2. 订阅 socket 的 chat:meta/delta/done/error 与 disconnect：流转给 chatReducer，done 后回填消息缓存
 * 3. 发送：生成本地 requestId → dispatch start（乐观显示问题）→ socket.emit('chat:send')
 * 4. 停止：emit('chat:cancel')，不改本地状态；等服务端回 cancelled=true 的 done 再收尾
 * 5. 删除会话：DELETE 后失效列表、清掉该会话的消息缓存
 * 6. 滚动：默认贴底，用户上滚超过 120px 就停止自动跟随并显示「回到底部」
 */
export function ChatPage() {
  const { kb, orgId, kbId } = useKbContext();
  const { socket, connected } = useSocket();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { user } = useAuth();

  const [activeId, setActiveId] = useState<string | null>(null);
  const [newChatMode, setNewChatMode] = useState(false);
  const [input, setInput] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Conversation | null>(null);
  const [stream, dispatch] = useReducer(chatReducer, initialChatState);
  const streamRef = useRef(stream);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const stickToBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);

  // effect 闭包拿不到最新的 stream，sync 一份到 ref 供 error/disconnect 回调与取消按钮读取
  useEffect(() => {
    streamRef.current = stream;
  }, [stream]);

  // 会话列表：键里带 orgId + kbId，切组织/切知识库自然是另一份缓存
  const conversationsQuery = useQuery({
    queryKey: ['conversations', orgId, kbId],
    queryFn: () =>
      apiFetch<Conversation[]>(`/orgs/${orgId}/knowledge-bases/${kbId}/conversations`),
  });

  // 供 chat:done 的回填逻辑复用：同一套 URL 与鉴权，避免两处各写一份
  const fetchMessages = (conversationId: string) =>
    apiFetch<Message[]>(
      `/orgs/${orgId}/conversations/${conversationId}/messages`,
    );

  // 当前会话消息；activeId 为空（新对话）时不发请求
  const messagesQuery = useQuery({
    queryKey: ['messages', orgId, activeId],
    queryFn: () => fetchMessages(activeId!),
    enabled: Boolean(activeId),
  });

  const conversations = conversationsQuery.data ?? [];
  const messages = messagesQuery.data ?? [];
  const isStreaming = stream.status === 'streaming';
  // 「有在途回答」：从发出问题到 done/reset 之前都算，包含 done 仍未被 reset 的短暂窗口
  const hasPending = stream.status !== 'idle';
  const activeConversation = conversations.find((item) => item.id === activeId);
  const title = activeConversation?.title ?? (hasPending ? '新对话' : '新对话');

  // 首次进入且不在「新对话」模式时，自动打开最近一条会话（列表已按 updated_at 倒序）。
  // newChatMode 是「用户刚点了新对话」的标记：没有它，列表刷新后会立刻把 activeId 塞回去
  useEffect(() => {
    if (newChatMode || activeId) return;
    if (conversations.length) setActiveId(conversations[0].id);
  }, [conversations, newChatMode, activeId]);

  /**
   * socket 事件订阅（依赖里的 socket 变化会整体重绑）。
   * 四个业务事件共用一条约定：事件都带 requestId，reducer 只接受与当前请求匹配的那一条。
   */
  useEffect(() => {
    if (!socket) return;

    // meta：服务端先检索后生成，先把 conversationId 与引用片段送过来
    const onMeta = (event: ChatMetaEvent) => {
      dispatch({
        type: 'meta',
        requestId: event.requestId,
        conversationId: event.conversationId,
        sources: event.sources,
      });
    };

    // delta：追加一段正文（累加在 reducer 里做）
    const onDelta = (event: ChatDeltaEvent) => {
      dispatch({ type: 'delta', requestId: event.requestId, text: event.text });
    };

    /**
     * done：生成结束（含用户点停止）。
     * 步骤 1. 先把 done 交给 reducer，结束「正在生成」的视觉状态
     * 步骤 2. 拉取该会话的消息并写入查询缓存
     * 步骤 3. 再切换 activeId 到该会话
     *
     * 顺序不能反（步骤 2 必须在步骤 3 之前）：如果先 setActiveId 再拉取，消息查询会以
     * 空缓存 + loading 渲染一帧，页面闪一下空白。这是修复过的线上问题（回答完成后闪空白），
     * 改成「先 fetchQuery 预热缓存，再切会话」后界面从流式气泡直接过渡到历史消息。
     */
    const onDone = (event: ChatDoneEvent) => {
      dispatch({
        type: 'done',
        requestId: event.requestId,
        conversationId: event.conversationId,
        cancelled: event.cancelled,
      });
      void (async () => {
        try {
          // 步骤 2：预热 ['messages', orgId, conversationId]，失败也不阻断后续切换
          await queryClient.fetchQuery({
            queryKey: ['messages', orgId, event.conversationId],
            queryFn: () => fetchMessages(event.conversationId),
          });
        } catch {
          // Fall through: the mounted query will retry and show its own state.
        }
        // 步骤 3：缓存就绪后才切会话，避免「切过去但还没数据」的那一帧
        setActiveId(event.conversationId);
        setNewChatMode(false);
        // 新会话会出现在列表顶部，标题也可能由首问生成
        queryClient.invalidateQueries({
          queryKey: ['conversations', orgId, kbId],
        });
        // 一并失效知识库列表缓存（与其它页面的刷新口径保持一致，不依赖本页的具体计数展示）
        queryClient.invalidateQueries({
          queryKey: ['knowledge-bases', orgId],
        });
        // 流式状态到此清空：此后这条回答只从消息查询里读（服务端已落库，取消时 interrupted=true）
        dispatch({ type: 'reset' });
        if (event.cancelled) {
          toast({ title: '已停止生成', type: 'info' });
        }
      })();
    };

    /**
     * error：服务端生成失败（或准入检查拒绝）。
     * reducer 记下错误文案供气泡展示；若 meta 已到（streamRef 里有 conversationId），
     * 切到该会话并失效消息缓存，让用户能看到已落库的问句/部分回答。
     * meta 之前的失败（如服务端已建会话但检索失败）拿不到 id，只留错误气泡。
     */
    const onError = (event: ChatErrorEvent) => {
      dispatch({
        type: 'error',
        requestId: event.requestId,
        message: event.message,
      });
      // 用 ref 读最新状态：本 effect 的闭包可能是旧的，不能直接读 stream
      const conversationId = streamRef.current.conversationId;
      if (conversationId) {
        setActiveId(conversationId);
        queryClient.invalidateQueries({
          queryKey: ['messages', orgId, conversationId],
        });
      }
      toast({
        title: '回答生成失败',
        description: event.message,
        type: 'error',
      });
    };

    /**
     * disconnect：连接断了但服务端可能已生成了一部分。
     * 只在「正在生成」时处理：清空流式状态并失效消息缓存，把服务端落库的部分重新拉回来。
     */
    const onDisconnect = () => {
      if (streamRef.current.status !== 'streaming') return;
      const conversationId = streamRef.current.conversationId;
      dispatch({ type: 'reset' });
      if (conversationId) {
        void queryClient.invalidateQueries({
          queryKey: ['messages', orgId, conversationId],
        });
      }
      toast({
        title: '实时连接已断开',
        description: '已保留已生成的内容，正在尝试重连。',
        type: 'info',
      });
    };

    socket.on('chat:meta', onMeta);
    socket.on('chat:delta', onDelta);
    socket.on('chat:done', onDone);
    socket.on('chat:error', onError);
    socket.on('disconnect', onDisconnect);

    return () => {
      socket.off('chat:meta', onMeta);
      socket.off('chat:delta', onDelta);
      socket.off('chat:done', onDone);
      socket.off('chat:error', onError);
      socket.off('disconnect', onDisconnect);
    };
  }, [socket, orgId, kbId, queryClient, toast]);

  /**
   * 删除会话：成功后失效会话列表、直接移除该会话的消息缓存（不重新请求）；
   * 删的是当前打开的会话就回到「新对话」空态。
   */
  const deleteMutation = useMutation({
    mutationFn: (conversationId: string) =>
      apiFetch(`/orgs/${orgId}/conversations/${conversationId}`, {
        method: 'DELETE',
      }),
    onSuccess: (_, conversationId) => {
      queryClient.invalidateQueries({ queryKey: ['conversations', orgId, kbId] });
      queryClient.removeQueries({ queryKey: ['messages', orgId, conversationId] });
      if (activeId === conversationId) {
        setActiveId(null);
        setNewChatMode(true);
      }
      setDeleteTarget(null);
      toast({ title: '会话已删除', type: 'success' });
    },
  });

  const scrollToBottom = () => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  };

  // 新消息、流式增量、状态变化时若仍处于「贴底」就跟着滚。
  // 依赖里的 stream.userText 让乐观回显的问题一出现就滚到底
  useEffect(() => {
    if (stickToBottom.current) {
      scrollToBottom();
      setShowJump(false);
    }
  }, [messages, stream.assistantText, stream.status, stream.userText]);

  // 距离底部 120px 内算贴底；离开后停止自动跟随并露出「回到底部」按钮
  const onScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    stickToBottom.current = distance < 120;
    setShowJump(!stickToBottom.current);
  };

  /**
   * 发送问题（输入框回车或点发送、点预置问题共用）。步骤：
   * 1. 校验：空问题、正在生成都直接返回（服务端也限制一条连接同时只有一个在途流）
   * 2. socket 未连接时只提示，不排队——重连后不会补发
   * 3. 生成 requestId（优先 crypto.randomUUID，环境不支持时退化为时间戳+随机数）
   * 4. dispatch start 先乐观显示问题并进入 streaming，再 emit；两者顺序保证界面上问题先出现
   * 5. 清空输入、重置滚动标记、异步聚焦回输入框
   * conversationId 传 undefined 表示新对话：会话由服务端在首问时创建，id 在 chat:meta 里回来
   */
  const sendMessage = (text = input) => {
    const question = text.trim();
    if (!question || isStreaming) return;
    if (!socket || !connected) {
      toast({
        title: '实时连接尚未就绪',
        description: '请稍等片刻或刷新页面。',
        type: 'error',
      });
      return;
    }
    const requestId =
      typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random()}`;
    dispatch({ type: 'start', requestId, userText: question });
    stickToBottom.current = true;
    setShowJump(false);
    setInput('');
    socket.emit('chat:send', {
      orgId,
      kbId,
      conversationId: activeId ?? undefined,
      question,
      requestId,
    });
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  };

  /**
   * 停止生成：只发 chat:cancel，不动本地状态。
   * 服务端会 abort 模型请求；已生成过内容就把这部分落库（interrupted=true），一段都没生成则什么都不写。
   * 两种情况的收尾都是一条 cancelled=true 的 chat:done——界面上的「已停止生成」等那条 done 到达后再切，
   * 避免前端先清空、随后又被事件补上的闪动。
   */
  const cancel = () => {
    if (!socket || !stream.requestId) return;
    socket.emit('chat:cancel', { requestId: stream.requestId });
  };

  // 新对话：仅非流式时可用（按钮本身也 disabled）；清空流式状态并让 activeId 为空
  const newChat = () => {
    if (isStreaming) return;
    dispatch({ type: 'reset' });
    setActiveId(null);
    setNewChatMode(true);
    setInput('');
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  };

  // 切换会话：同样在流式期间禁用，切换前清掉上一条的流式残留
  const selectConversation = (conversationId: string) => {
    if (isStreaming) return;
    dispatch({ type: 'reset' });
    setActiveId(conversationId);
    setNewChatMode(false);
  };

  // 空态判定：有在途回答时永远不显示引导页；否则新对话模式、没有任何会话、或当前会话没有消息时显示
  const showWelcome =
    !hasPending &&
    (newChatMode || (!activeId && conversations.length === 0) || messages.length === 0);

  return (
    // 桌面端两栏（248px 会话栏 + 自适应主区）；窄屏只留主区，会话切换靠 header 里的下拉
    <div className="grid gap-4 lg:grid-cols-[248px_minmax(0,1fr)]">
      {/* 会话侧栏只在 lg 及以上显示，高度与主区一致，内部自己滚动 */}
      <aside className="hidden h-[calc(100dvh-21rem)] min-h-[560px] overflow-hidden rounded-2xl border border-line bg-white shadow-sm lg:flex">
        <ConversationList
          conversations={conversations}
          activeId={activeId}
          disabled={isStreaming}
          onSelect={selectConversation}
          onNew={newChat}
          onDelete={setDeleteTarget}
        />
      </aside>

      <section className="flex h-[calc(100dvh-21rem)] min-h-[560px] flex-col overflow-hidden rounded-2xl border border-line bg-white shadow-sm">
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-line px-4 sm:px-5">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-soft text-accent">
              <Sparkles className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-ink">{title}</p>
              <p className="mt-0.5 flex items-center gap-1.5 text-[10px] text-soft">
                <span
                  className={cn(
                    'h-1.5 w-1.5 rounded-full',
                    connected ? 'bg-emerald-500' : 'bg-amber-400',
                  )}
                />
                {connected ? '已连接 · Atlas RAG' : '连接中…'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* 移动端替代侧栏的会话选择器：空值代表新对话 */}
            <select
              value={activeId ?? ''}
              disabled={isStreaming}
              onChange={(event) => {
                if (!event.target.value) newChat();
                else selectConversation(event.target.value);
              }}
              className="h-9 max-w-36 rounded-lg border border-line bg-white px-2 text-xs text-ink outline-none lg:hidden"
              aria-label="选择会话"
            >
              <option value="">新对话</option>
              {conversations.map((conversation) => (
                <option key={conversation.id} value={conversation.id}>
                  {conversation.title}
                </option>
              ))}
            </select>
            <Button
              variant="secondary"
              size="sm"
              onClick={newChat}
              disabled={isStreaming}
              className="hidden sm:inline-flex"
            >
              <Plus className="h-4 w-4" />
              新对话
            </Button>
            <button
              type="button"
              onClick={newChat}
              disabled={isStreaming}
              className="rounded-lg border border-line p-2 text-muted sm:hidden"
              aria-label="新对话"
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>
        </header>

        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="relative flex-1 overflow-y-auto px-4 py-5 sm:px-6"
        >
          {/*
           * 首屏加载守卫：三个条件缺一不可。
           * - activeId：新对话没有会话可加载，直接走引导页
           * - !hasPending：有在途回答时不显示整页 loader，否则会把流式气泡（或刚 done 的那一帧）替换成加载页
           * - isLoading：只在没有可用缓存的首载时为真，后台 refetch 不会闪 loader
           */}
          {messagesQuery.isLoading && activeId && !hasPending ? (
            <PageLoader label="正在加载对话…" />
          ) : showWelcome ? (
            <WelcomePanel
              kbName={kb.name}
              disabled={!connected}
              onSuggestion={(text) => sendMessage(text)}
            />
          ) : (
            <div className="mx-auto max-w-3xl space-y-6">
              {messages.map((message) => (
                <MessageBubble key={message.id} message={message} userName={user?.name ?? 'You'} />
              ))}

              {/* 在途回答气泡：done 之后、ChatPage reset 之前的短暂窗口也走这里，保证不闪 */}
              {hasPending ? (
                <>
                  {/* 用户问题：从 start 起本地显示；status 变成 done 后不再重复渲染（随后由消息查询补上） */}
                  {stream.userText && stream.status !== 'done' ? (
                    <div className="flex justify-end gap-3">
                      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-sidebar px-4 py-2.5 text-sm leading-relaxed text-white shadow-sm">
                        <p className="whitespace-pre-wrap">{stream.userText}</p>
                      </div>
                      <Avatar name={user?.name ?? 'You'} size="sm" className="mt-0.5" />
                    </div>
                  ) : null}

                  <div className="flex gap-3">
                    <AssistantMark />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-ink">Atlas</span>
                        {stream.status === 'streaming' ? (
                          <span className="inline-flex items-center gap-1.5 text-[10px] text-accent">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            正在生成
                          </span>
                        ) : null}
                        {stream.cancelled ? <Badge tone="warning">已停止生成</Badge> : null}
                      </div>

                      {stream.status === 'error' ? (
                        <div className="mt-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3">
                          <div className="flex items-start gap-2 text-sm text-red-700">
                            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                            <div>
                              <p className="font-medium">回答生成失败</p>
                              <p className="mt-1 text-xs leading-relaxed">{stream.error}</p>
                              <button
                                type="button"
                                onClick={() => dispatch({ type: 'reset' })}
                                className="mt-2 text-xs font-medium text-red-700 underline underline-offset-2"
                              >
                                关闭提示
                              </button>
                            </div>
                          </div>
                        </div>
                      ) : stream.assistantText ? (
                        <div className="mt-1.5">
                          <MarkdownText content={stream.assistantText} />
                        </div>
                      ) : (
                        <div className="mt-3 flex gap-1">
                          {[0, 1, 2].map((dot) => (
                            <span
                              key={dot}
                              className="h-1.5 w-1.5 animate-bounce rounded-full bg-indigo-300"
                              style={{ animationDelay: `${dot * 120}ms` }}
                            />
                          ))}
                        </div>
                      )}

                      {stream.sources.length ? <Sources sources={stream.sources} /> : null}
                    </div>
                  </div>
                </>
              ) : null}
            </div>
          )}
        </div>

        {showJump ? (
          <button
            type="button"
            onClick={() => {
              stickToBottom.current = true;
              setShowJump(false);
              scrollToBottom();
            }}
            className="absolute bottom-28 left-1/2 z-10 -translate-x-1/2 rounded-full border border-line bg-white px-3 py-1.5 text-xs text-muted shadow-md transition hover:text-ink"
          >
            <ChevronDown className="mr-1 inline h-3.5 w-3.5" />
            回到底部
          </button>
        ) : null}

        <div className="shrink-0 border-t border-line bg-white px-3 pb-3 pt-3 sm:px-4">
          <div className="mx-auto max-w-3xl">
            <div className="rounded-2xl border border-line bg-white p-2 shadow-sm transition focus-within:border-accent/40 focus-within:ring-2 focus-within:ring-accent/10">
              <textarea
                ref={textareaRef}
                rows={1}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                // Enter 发送、Shift+Enter 换行；未判断输入法组合态（isComposing），中文选词时的 Enter 同样会发送
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    sendMessage();
                  }
                }}
                // 上限与服务端 chat:send 的长度校验一致（1–2000 字），前端提前拦住避免白跑一次 socket
                maxLength={2000}
                placeholder="向知识库提问…"
                className="max-h-40 min-h-[48px] w-full resize-none bg-transparent px-3 py-2 text-sm leading-relaxed text-ink outline-none placeholder:text-soft"
              />
              <div className="flex items-center justify-between gap-3 px-2 pb-1">
                <div className="flex items-center gap-2 text-[10px] text-soft">
                  <span className={cn('h-1.5 w-1.5 rounded-full', connected ? 'bg-emerald-500' : 'bg-amber-400')} />
                  {connected ? '知识库已连接' : '连接中…'}
                  {input.length > 1800 ? (
                    <span className={input.length >= 2000 ? 'text-red-600' : 'text-amber-600'}>
                      {input.length}/2000
                    </span>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  {/* 流式期间显示「停止」；停止走 chat:cancel，见 cancel() */}
                  {isStreaming ? (
                    <Button variant="secondary" size="sm" onClick={cancel}>
                      <Square className="h-3.5 w-3.5 fill-current" />
                      停止
                    </Button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => sendMessage()}
                    disabled={!input.trim() || isStreaming || !connected}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-accent text-white shadow-sm transition hover:bg-accent-dark disabled:cursor-not-allowed disabled:bg-stone-200 disabled:text-soft"
                    aria-label="发送"
                  >
                    <ArrowUp className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
            <p className="mt-2 text-center text-[10px] text-soft">
              回答基于知识库内容生成，请核对引用来源。Enter 发送 · Shift + Enter 换行
            </p>
          </div>
        </div>
      </section>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) deleteMutation.mutate(deleteTarget.id);
        }}
        title="删除会话"
        description={`确定删除「${deleteTarget?.title ?? ''}」吗？会话中的消息将一并删除。`}
        busy={deleteMutation.isPending}
      />
    </div>
  );
}
