/**
 * Socket.IO 连接生命周期的唯一所有者：登录态决定「连不连」，把 socket 实例 + connected 布尔
 * 通过 Context 交给页面复用（全站一条连接，不是每个页面各开一条）。
 *
 * 边界：本文件只管连接本身——它不加入任何知识库房间、不认识 kb:join、也不订阅业务事件。
 * 房间归属是使用方的事，目前只有一处：KbLayout.tsx:61-122 在 `socket && connected` 都成立时
 * 才 `emitWithAck('kb:join')`，卸载时 `kb:leave`。这个时机选择有两个后果值得知道：
 * - connected 每次由 false→true 都会重跑那个 effect（依赖里有 connected），所以断线重连后
 *   会自动重新入房，不需要额外补 join
 * - 反过来，连接没就绪时页面根本不发 join，广播也就无从谈起，页面各自有兜底
 *   （DocumentsPage.tsx:160-169 在未连接时启用轮询，ChatPage.tsx:467/596 在未连接时禁用发送）
 *
 * kb:join 的 ack 契约（服务端 realtime.gateway.ts#join，前端消费见 KbLayout.tsx:65-80）：
 * - { ok: true, permission }：已入房；permission 是服务端解析出的有效权限，前端目前没人读它
 * - { ok: false }：会话失效 / 负载缺字段 / 库不存在 / 跨组织 / 等级不够 / 服务端抛异常，
 *   全部塌成这一个值（刻意与 HTTP 侧「一律 404」同口径，不向外承认某个 kbId 存不存在）。
 *   前端据此整页切到「实时权限校验未通过」（joinDenied）
 * - 超时/抛错（emitWithAck 的 5s 超时走 catch 分支）：与 ok 无关，只弹一条 info toast
 *   「实时连接暂时不可用」，页面照常可用，只是收不到实时推送
 *
 * 与 HTTP 侧的分工：鉴权口径一样但代码是两套——握手期服务端自己解 Cookie 验会话，
 * 每条要紧消息再 revalidate 一次；这里的 fetch 走的是 lib/api.ts。
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { io, type Socket } from 'socket.io-client';
import { useAuth } from '../features/auth/AuthProvider';

/** Context 的载荷：socket 实例（未登录时为 null）与「当前是否连着」 */
interface SocketContextValue {
  socket: Socket | null;
  connected: boolean;
}

const SocketContext = createContext<SocketContextValue | null>(null);

/**
 * 建连接、维护 connected，并在登出/换账号时拆掉旧连接。
 * 步骤：
 * 1. 没有 user 就什么都不做（并把 context 清空），登录成功后才由 effect 重跑建立连接
 * 2. io() 不带 URL：连到当前页面同源，开发时靠 vite.config.ts:11 的 /socket.io 代理（ws:true），
 *    生产靠同源反代。withCredentials:true 是必须的——服务端握手中间件只认 Cookie 里的 kr_session
 *    （realtime.gateway.ts afterInit 第 2 步手工解析），不带 Cookie 一律握手失败
 * 3. transports 只留 websocket，不做长轮询回退，因此代理链路上必须放行 ws 升级
 * 4. 订阅 connect/disconnect 维护 connected；订阅 connect_error 打日志
 * 5. 清理时先摘监听再 close()，并把 state 归零，避免组件卸载后 context 里还挂着一个已关闭的实例
 * 依赖只取 user?.id：改名、组织列表变化都不会重连（连接身份只看 id）；换账号或登出才会。
 * 服务端另有 24 小时强制断开（gateway handleConnection 第 4 步），到点后靠这里的
 * reconnection（1s 起、最多 5s）自动重连并重新走握手，等于一次例行身份复验。
 */
export function SocketProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    // 步骤 1：未登录不建连接
    if (!user) {
      setSocket(null);
      setConnected(false);
      return;
    }

    const next = io({
      transports: ['websocket'],
      withCredentials: true,
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    next.on('connect', onConnect);
    next.on('disconnect', onDisconnect);
    next.on('connect_error', (error) => {
      setConnected(false);
      // 步骤 4：服务端把所有握手失败都收敛成 new Error('unauthorized')
      // （Origin 不对 / 没登录 / 会话过期都是这一句），所以它是预期内的常态，不刷警告；
      // 真正的网络故障才会走到 console.warn
      if (error.message !== 'unauthorized') {
        console.warn('socket connection error', error.message);
      }
    });
    setSocket(next);

    // 步骤 5：拆连接
    return () => {
      next.off('connect', onConnect);
      next.off('disconnect', onDisconnect);
      next.close();
      setSocket(null);
      setConnected(false);
    };
  }, [user?.id]);

  // 只在 socket / connected 真的变化时才换 context 引用，避免父组件重渲染把订阅者全部叫醒
  const value = useMemo(() => ({ socket, connected }), [socket, connected]);
  return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>;
}

/**
 * 取当前连接与在线状态；socket 在登出态或未挂载 Provider 时不可用。
 * 拿不到 context 直接抛错而不是返回 null，是为了让「忘了套 SocketProvider」在开发期立刻暴露
 * （Provider 挂在 app/providers.tsx:27，位于 AuthProvider 之内，因为它要读 user）。
 */
export function useSocket() {
  const context = useContext(SocketContext);
  if (!context) throw new Error('useSocket must be used inside SocketProvider');
  return context;
}
