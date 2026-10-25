/**
 * 前端登录边界（auth boundary）：App.tsx 里那条没有 path 的布局路由就是它，
 * 包住 / 与 /orgs/** 这些需要登录的页面，未登录就把用户送到 /login 并记住原地址。
 * 判据只有一条，来自 useAuth()（features/auth/AuthProvider.tsx 的 ['me'] 查询）：
 * 1. isLoading（/auth/me 还没回来）→ 渲染 PageLoader，不渲染任何业务内容
 * 2. user 为空 → <Navigate to="/login?next=…" replace/>；next 是当前 pathname+search 做
 *    encodeURIComponent，回到登录页后由 LoginPage 的 safeNext 消毒（只认以单个 '/' 开头的
 *    站内路径），所以这里传什么原始值都不会被当成外站跳转
 * 3. user 有值 → <Outlet />，把渲染交给子路由
 * 它【不检查】的东西，别把它当成安全边界：
 * - 不检查组织成员身份与角色：只要 user 有值就放行，别人的 /orgs/:orgId 也能进到子路由，
 *   回弹由 AppShell 做（它在 organizations 里查不到该 orgId 就 <Navigate to="/">），
 *   权威判定仍是服务端的 OrgMemberGuard（非成员一律 404）
 * - 不检查知识库权限，也不看 organizations 列表是否为空（那是 HomeRedirect / AppShell 的事）
 * - 不校验会话在服务端是否仍然有效：它读的是 React Query 的本地缓存，
 *   staleTime 30 秒内不再回源；会话被服务端撤销后，要等下一次 apiFetch 收到 401
 *   派发 auth:unauthorized（AuthProvider 的 effect 把 ['me'] 置空）才会走到第 2 步
 * - 不看 error：/auth/me 因网络或 5xx 失败时 user 仍是 null，也会被送到 /login，
 *   即「后端故障」与「没登录」在这一层是同一种表现（现状，非本文件的判断）
 * 边界：不做跳转以外的登录逻辑（登录/注册/登出请求都在 AuthProvider），
 *      也不带 ToastProvider/SocketProvider 之外的任何副作用。
 */
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { PageLoader } from '../components/ui/spinner';
import { useAuth } from '../features/auth/AuthProvider';

export function ProtectedRoute() {
  const { user, isLoading } = useAuth();
  const location = useLocation();

  // 步骤 1：引导查询未结束先占位，避免「闪一下登录页又把用户带回来」
  if (isLoading) return <PageLoader label="正在加载工作区…" />;
  // 步骤 2：没登录就跳登录页，replace 让受保护页不留在历史栈里，登录后按返回键不会退回来
  if (!user) {
    // next 只带 pathname + search，不带 hash：锚点位置对登录后落地没意义
    const next = encodeURIComponent(`${location.pathname}${location.search}`);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  // 步骤 3：放行，子路由（HomeRedirect / AppShell / OrgOnboardingPage）照常渲染
  return <Outlet />;
}
