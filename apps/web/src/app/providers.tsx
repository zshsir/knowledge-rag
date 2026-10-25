/**
 * 应用的全局依赖装配（composition root）：只负责把五个 Provider 按固定顺序套起来。
 * 唯一消费方是 src/main.tsx，它把 <Providers><App/></Providers> 挂到 #root 上。
 * 职责：给出 React Query 缓存、路由 history、toast 面板、登录态、WebSocket 连接这五样的实例。
 * 不做什么：不含路由表（在 app/App.tsx）、不做鉴权判断与跳转（在 app/ProtectedRoute.tsx）、
 *      不发任何请求、没有 ErrorBoundary（渲染期异常走 React 默认的白屏，本文件没兜）、
 *      没有主题/i18n/持久化缓存这些 Provider——仓库里没有它们。
 * 嵌套顺序是有约束的，别随意调换（同样记在 main.tsx 文件头的步骤 3）：
 * - QueryClientProvider 必须在最外：AuthProvider 用 useQuery 拉 /auth/me
 * - BrowserRouter 在 ToastProvider 与 App 之外：toast 面板刻意不用 portal，而是挂在 Provider 子树里
 *   的 fixed 容器（components/ui/toast.tsx），要在路由上下文里压住页面内容就得在这层
 * - AuthProvider 必须在 SocketProvider 之外：SocketProvider 读 useAuth().user 才决定要不要连
 *   （lib/socket.tsx 的连接 effect 依赖 user?.id）
 */
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { ToastProvider } from '../components/ui/toast';
import { AuthProvider } from '../features/auth/AuthProvider';
import { SocketProvider } from '../lib/socket';

export function Providers({ children }: { children: React.ReactNode }) {
  /**
   * QueryClient 用 useState 的惰性初始化来建。
   * 为什么这么写：直接 `const client = new QueryClient()` 每次 render 都会造一个新缓存实例，
   * 所有已取到的数据随之作废；useState(() => ...) 保证一个挂载周期内只建一个、引用恒定。
   * 下面的三个 defaultOptions 是全局默认值，单个 useQuery 都能覆盖：
   * - staleTime 20_000：20 秒内同一 queryKey 的数据算新鲜，切回已挂载的页面不会立刻重取
   * - retry 1：失败只补一次（React Query 默认重试 3 次），全应用统一口径，个别 query 可自行覆盖
   * - refetchOnWindowFocus false：窗口重新获得焦点不自动重取，避免切标签页回来时整屏数据闪一下
   */
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 20_000,
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  // 五层包裹，从外到内：数据缓存 → 路由 → toast → 登录态 → 实时连接；children 是 main.tsx 传进来的 <App />
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ToastProvider>
          <AuthProvider>
            <SocketProvider>{children}</SocketProvider>
          </AuthProvider>
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
