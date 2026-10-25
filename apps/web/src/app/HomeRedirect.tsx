/**
 * 首页分流器：根路由 `/` 没有页面本体，它只负责把人带去「该去的那个组织」。
 * 由 App.tsx 挂在 <Route path="/" element={<HomeRedirect />} />，且套在 ProtectedRoute 之内，
 * 所以走到这里时 user 已经非空（未登录早就被 ProtectedRoute 送去 /login 了）。
 * 步骤：
 * 1. isLoading（['me'] 查询未回来）→ 先渲染 PageLoader，不能提前判定「没有组织」
 * 2. organizations 空数组 → /orgs/new，即组织引导页 OrgOnboardingPage（一个组织都没加入过）
 * 3. 否则 → /orgs/{organizations[0].id}
 *    这个 [0] 不是随机取：接口侧 GET /auth/me 的组织列表来自
 *    OrganizationsRepository.listForUser，SQL 是 `ORDER BY o.created_at ASC`，
 *    所以落地的是「他所属的组织里最早创建的那个」（按组织创建时间排，不是按加入时间排），
 *    顺序稳定，不会随登录次数漂移
 * 三条分支都用 replace：`/` 不该留在浏览器历史里，否则从组织页按返回键会弹回这里再跳一次。
 * 不做什么：不校验 orgId 权限（成员身份由服务端 OrgMemberGuard 判，AppShell 也只做「在不在列表里」这一层）；
 *      不记住上次访问的组织、不做「多组织时让人自己选」——想要选择请用侧栏的 OrgSwitcher。
 */
import { Navigate } from 'react-router-dom';
import { PageLoader } from '../components/ui/spinner';
import { useAuth } from '../features/auth/AuthProvider';

export function HomeRedirect() {
  const { organizations, isLoading } = useAuth();
  // 步骤 1：登录态引导中，先占位（PageLoader 不带 label，用组件默认的「加载中…」）
  if (isLoading) return <PageLoader />;
  // 步骤 2：零组织 → 去创建第一个组织
  if (!organizations.length) return <Navigate to="/orgs/new" replace />;
  // 步骤 3：有组织 → 所属组织里最早创建的那个
  return <Navigate to={`/orgs/${organizations[0].id}`} replace />;
}
