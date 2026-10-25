/**
 * 组织级应用外壳：`/orgs/:orgId` 这条布局路由的组件，负责左侧导航栏 + 右侧 <Outlet/>。
 * 全站唯一的「组织级导航」侧栏就是这一份（ChatPage 的会话列表 aside、AuthLayout 的 aside 都不在这一定位内），
 * 它同时是「组织切换器 + 知识库导航 + 用户菜单」三块的宿主。
 * 职责：
 * 1. 把 URL 上的 :orgId 和登录态里的组织列表对上，对不上就把人弹回 '/'
 * 2. 渲染侧栏（组织切换、知识库总览入口、知识库列表、底部用户菜单）与移动端抽屉
 * 3. 持有两个纯 UI 状态：mobileOpen（移动抽屉）、createOpen（新建知识库对话框）
 * 4. 挂载一份知识库列表查询，供侧栏导航用
 * 不做什么 / 边界（这几条容易误解，逐条说明）：
 * - 它不是权限边界。`organizations.find(...)` 只看「这个 orgId 在不在我['me']返回的组织列表里」，
 *   权威判定在服务端 OrgMemberGuard（非成员一律 404）。前端这层拦的意义只有「不给非成员看侧栏」。
 * - 不做角色门槛：侧栏底部菜单里的「组织成员」「组织设置」两个入口对所有成员无条件渲染，
 *   owner/admin 的差别由目标页面自己判（OrgMembersPage 的 canManage、OrgSettingsPage 的 isOwner）
 *   以及后端接口校验。
 * - 不判知识库权限：列表里显示什么完全取决于 GET /orgs/:orgId/knowledge-bases 返回了什么。
 * - 不订阅 WebSocket、不取文档/会话数据；那些在 KbLayout 之下的各功能页里。
 * - 不含路由表（App.tsx）、不含登录态获取（AuthProvider）。
 * 响应式做法：侧栏是 fixed 定位、常驻 DOM，靠 translate-x 在移动端滑入滑出（不是条件渲染），
 *      桌面端由 lg:translate-x-0 恒定显示，正文再用 lg:pl-72 让出 18rem 宽度。
 */
import { useEffect, useState } from 'react';
import { Link, Navigate, NavLink, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Globe2,
  LayoutGrid,
  Lock,
  LogOut,
  Menu,
  Plus,
  Settings2,
  Users,
  X,
} from 'lucide-react';
import { Logo } from '../components/ui/logo';
import { Avatar } from '../components/ui/avatar';
import { Dropdown, DropdownItem, DropdownSeparator } from '../components/ui/dropdown';
import { Skeleton } from '../components/ui/skeleton';
import { Button } from '../components/ui/button';
import { useAuth } from '../features/auth/AuthProvider';
import { OrgSwitcher } from '../features/organizations/OrgSwitcher';
import { CreateKbDialog } from '../features/knowledge-bases/CreateKbDialog';
import { apiFetch } from '../lib/api';
import type { KnowledgeBase } from '../lib/types';
import { cn } from '../lib/cn';

/**
 * 侧栏里的知识库导航列表（本文件私有，桌面侧栏与移动抽屉共用）。
 * 步骤：
 * 1. 用 useQuery 拉 GET /orgs/{orgId}/knowledge-bases，queryKey 是 ['knowledge-bases', orgId]
 *    ——orgId 进了键，所以切组织必然重新取数，不会把 A 组织的库列表留在 B 组织的侧栏上
 * 2. 四种渲染分支，按优先级排：isLoading → 三条 h-9 骨架；isError → 一个「加载失败，点击重试」
 *    按钮（onClick 就是 query.refetch()，没有额外的重试计数或退避）；有数据 → 列表；空数组 → 引导文案
 * 3. 列表项：to 固定指向该库的 chat 子路由（进库先看对话，和 App.tsx 里 kbs/:kbId 的 index
 *    重定向是同一个落点）；高亮判据是 `location.pathname.includes('/kbs/${kb.id}')`，
 *    因此库下的 documents/members 子页也算「这个库处于当前」
 * 4. 每行右侧图标表示访问模式：accessMode === 'restricted' 上一把锁，否则地球图标；
 *    documentCount 用真值判断，所以 0 篇时这个数字干脆不显示（不是显示 0）
 * 5. onCreate / onNavigate 两个回调由 AppShell 传下来：前者打开新建对话框，后者在点链接时
 *    关掉移动抽屉（桌面端调它也没副作用）
 * 边界：不发写请求、不做权限判断（能看到哪些库由接口决定），也不管理自己那份数据的失效。
 */
function KbNavList({
  orgId,
  onCreate,
  onNavigate,
}: {
  orgId: string;
  onCreate: () => void;
  onNavigate?: () => void;
}) {
  const location = useLocation();
  const query = useQuery({
    queryKey: ['knowledge-bases', orgId],
    queryFn: () => apiFetch<KnowledgeBase[]>(`/orgs/${orgId}/knowledge-bases`),
  });

  return (
    <div className="mt-2 flex-1 overflow-y-auto px-1">
      {query.isLoading ? (
        // 步骤 2：骨架屏三条，尺寸对着真实列表行估的，避免加载完成时高度跳动
        <div className="space-y-2 px-2 py-1">
          {[1, 2, 3].map((item) => (
            <Skeleton key={item} className="h-9 bg-white/5" />
          ))}
        </div>
      ) : query.isError ? (
        // 步骤 2：失败态给一个可点的重试，不静默转圈
        <button
          type="button"
          onClick={() => query.refetch()}
          className="w-full rounded-lg px-2 py-2 text-left text-xs text-slate-400 hover:bg-white/5"
        >
          加载失败，点击重试
        </button>
      ) : query.data?.length ? (
        <div className="space-y-0.5">
          {query.data.map((kb) => {
            // 步骤 3：用子串匹配判断「当前库」，同一库下的所有子页都保持高亮
            const active = location.pathname.includes(`/kbs/${kb.id}`);
            return (
              <Link
                key={kb.id}
                to={`/orgs/${orgId}/kbs/${kb.id}/chat`}
                onClick={onNavigate}
                className={cn(
                  'group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] outline-none transition',
                  active
                    ? 'bg-white/10 text-white'
                    : 'text-slate-300 hover:bg-white/[0.06] hover:text-white',
                )}
              >
                <span
                  className={cn(
                    'h-1.5 w-1.5 rounded-full',
                    active ? 'bg-indigo-300' : 'bg-slate-600 group-hover:bg-slate-400',
                  )}
                />
                <span className="min-w-0 flex-1 truncate">{kb.name}</span>
                {/* 步骤 4：访问模式图标——restricted 是「只有被授权的人能看到内容」，org 是全组织可见 */}
                {kb.accessMode === 'restricted' ? (
                  <Lock className="h-3 w-3 text-amber-400/70" />
                ) : (
                  <Globe2 className="h-3 w-3 text-slate-600" />
                )}
                {/* 步骤 4：文档数用真值判断，0 篇时这一格直接不渲染 */}
                {kb.documentCount ? (
                  <span className="text-[10px] text-slate-500">{kb.documentCount}</span>
                ) : null}
              </Link>
            );
          })}
        </div>
      ) : (
        // 步骤 2：空态——一句引导 + 一个「新建知识库」文字按钮，走的还是 onCreate
        <div className="px-2 py-4">
          <p className="text-xs leading-relaxed text-slate-500">
            还没有知识库。创建第一个，开始沉淀团队资料。
          </p>
          <button
            type="button"
            onClick={onCreate}
            className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-indigo-300 hover:text-indigo-200"
          >
            <Plus className="h-3.5 w-3.5" />
            新建知识库
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * 外壳主体（App.tsx 里 /orgs/:orgId 这条布局路由的 element）。
 * 步骤：
 * 1. 取三路输入：URL 参数 orgId、useAuth() 的 {user, organizations, logout}、路由的
 *    navigate/location；再加两个本地 UI 状态 mobileOpen 与 createOpen
 *    ——所有 Hook 都在下面两个提前 return 之前调用完，这是 React 的硬性要求：
 *    把 useXxx 挪到 return 之后，两次渲染的 Hook 数量就会不一致而报错
 * 2. useEffect 把「URL 变了」当成「关掉抽屉」：依赖只有 location.pathname，
 *    所以点侧栏任意链接、以及从菜单进成员/设置页都会顺手收起移动端侧栏
 * 3. org = organizations.find(id === orgId)：拿不到就 <Navigate to="/" replace/>。
 *    两条 return 覆盖 user 为空、orgId 为空、org 不在列表三种情况；
 *    这里不回跳 /login 也不弹「无权访问」——登录态交给 ProtectedRoute，
 *    真·越权交给服务端 404，本层只做静默重定向
 * 4. 侧栏内容从上到下四块：Logo/关闭按钮 → OrgSwitcher → 总览入口 + 知识库列表（含新建按钮）
 *    → 底部用户菜单。列表区那个 h-[calc(100%-5.5rem)] 是写死的扣高，扣的是上方总览链接和
 *    「知识库」标题行两排，剩下的空间交给 KbNavList 自己滚（overflow-y-auto）
 * 5. 主体 return 叠三层：aside（z-40，常驻 DOM 靠 translate-x 滑动）→ 遮罩按钮（z-30，
 *    仅 mobileOpen 时渲染，lg 隐藏）→ 右侧 lg:pl-72 的内容列（移动端顶栏 z-20 + <main> 里的 Outlet）
 * 6. CreateKbDialog 渲染在与侧栏、正文同级的最外层：它只看 createOpen 这一个布尔量，
 *    因此抽屉开合、桌面还是移动端都不影响它出现；新建成功后 onCreated 导航到该库的 documents 页，
 *    和侧栏列表项默认进 chat 是两个不同的落点
 * 退出登录这一支的顺序：先 close() 收菜单，再 await logout()（AuthProvider 的 logout 在
 * finally 里清掉 ['me'] 与非 ['me'] 的业务缓存，所以 user 随之变 null，ProtectedRoute 也会把人送去
 * /login），最后显式 navigate('/login', {replace:true})——两个动作的目的地都是 /login，
 * 差别只在 ProtectedRoute 那一次会带 ?next=，这最后一次不带。
 */
export function AppShell() {
  const { orgId } = useParams();
  const { user, organizations, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // 步骤 1：两个纯 UI 开关，不进任何缓存，刷新即回默认值
  const [mobileOpen, setMobileOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  // 步骤 2：换路由就关抽屉
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  const org = organizations.find((item) => item.id === orgId);

  // 步骤 3：没有登录态 / 没有 orgId / orgId 不属于自己的组织，一律静默回首页
  if (!user || !orgId) return <Navigate to="/" replace />;
  if (!org) return <Navigate to="/" replace />;

  // 步骤 4~5：侧栏是一整棵 JSX 变量，只在下面的 return 里被用一次
  const sidebar = (
    <aside
      className={cn(
        'fixed inset-y-0 left-0 z-40 flex w-72 flex-col bg-sidebar px-4 py-5 text-white transition-transform duration-200 lg:translate-x-0',
        mobileOpen ? 'translate-x-0' : '-translate-x-full',
      )}
    >
      <div className="flex items-center justify-between px-1">
        <Link to="/" aria-label="Atlas 首页">
          <Logo light />
        </Link>
        <button
          type="button"
          onClick={() => setMobileOpen(false)}
          className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white lg:hidden"
          aria-label="关闭侧栏"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-7">
        {/* 步骤 4：组织切换器——当前 org 和整份 organizations 都传下去，切换由它自己 navigate */}
        <OrgSwitcher org={org} organizations={organizations} />
      </div>

      <div className="mt-5 flex-1 overflow-hidden">
        {/* 步骤 4：总览入口用 NavLink + end，只有正好停在 /orgs/{orgId} 时才高亮，
            进到某个库时高亮让给下面的列表项 */}
        <NavLink
          to={`/orgs/${org.id}`}
          end
          className={({ isActive }) =>
            cn(
              'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition',
              isActive
                ? 'bg-white/10 text-white'
                : 'text-slate-300 hover:bg-white/[0.06] hover:text-white',
            )
          }
        >
          <LayoutGrid className="h-4 w-4" />
          知识库总览
        </NavLink>

        <div className="mt-6 flex items-center justify-between px-2.5">
          <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            知识库
          </span>
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="rounded-md p-1 text-slate-400 transition hover:bg-white/10 hover:text-white"
            aria-label="新建知识库"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>

        <div className="flex h-[calc(100%-5.5rem)] flex-col">
          {/* 步骤 4：列表本体 + 底部那条虚线「新建知识库」按钮，两者都调同一个 setCreateOpen */}
          <KbNavList
            orgId={org.id}
            onCreate={() => setCreateOpen(true)}
            onNavigate={() => setMobileOpen(false)}
          />
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-white/15 px-3 py-2.5 text-xs font-medium text-slate-300 transition hover:border-indigo-400/40 hover:bg-white/[0.04] hover:text-white"
          >
            <Plus className="h-3.5 w-3.5" />
            新建知识库
          </button>
        </div>
      </div>

      <div className="mt-4 border-t border-white/10 pt-4">
        {/* 步骤 4：底部用户菜单。panelClassName 覆盖 Dropdown 默认的面板定位，把面板放在触发器上方
            （bottom-[calc(100%+8px)] + top-auto，见 components/ui/dropdown.tsx 对 panelClassName 的说明）；
            菜单里的 name/email 只是展示，两项入口对所有组织成员都渲染，不带权限含义 */}
        <Dropdown
          trigger={
            <button
              type="button"
              className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left outline-none transition hover:bg-white/[0.06] focus-visible:ring-2 focus-visible:ring-indigo-400/40"
            >
              <Avatar name={user.name} size="md" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-white">
                  {user.name}
                </span>
                <span className="block truncate text-[11px] text-slate-500">{user.email}</span>
              </span>
            </button>
          }
          panelClassName="bottom-[calc(100%+8px)] top-auto w-full"
        >
          {(close) => (
            <>
              <div className="px-3 py-2">
                <p className="truncate text-sm font-medium text-ink">{user.name}</p>
                <p className="truncate text-xs text-muted">{user.email}</p>
              </div>
              <DropdownSeparator />
              <DropdownItem
                onClick={() => {
                  close();
                  navigate(`/orgs/${org.id}/members`);
                }}
              >
                <Users className="h-4 w-4 text-muted" />
                组织成员
              </DropdownItem>
              <DropdownItem
                onClick={() => {
                  close();
                  navigate(`/orgs/${org.id}/settings`);
                }}
              >
                <Settings2 className="h-4 w-4 text-muted" />
                组织设置
              </DropdownItem>
              <DropdownSeparator />
              {/* 步骤 4：退出这一支的顺序见本方法头注释——先收菜单，再等 logout 落定，最后 replace 到登录页 */}
              <DropdownItem
                danger
                onClick={async () => {
                  close();
                  await logout();
                  navigate('/login', { replace: true });
                }}
              >
                <LogOut className="h-4 w-4" />
                退出登录
              </DropdownItem>
            </>
          )}
        </Dropdown>
      </div>
    </aside>
  );

  return (
    <div className="min-h-dvh bg-canvas">
      {sidebar}
      {/* 步骤 5：遮罩只在 mobileOpen 时挂一个全屏按钮（不是 div），点它即关抽屉；
          z-30 压在侧栏(z-40)之下、正文之上，lg 断点直接隐藏，桌面端不会出现 */}
      {mobileOpen ? (
        <button
          type="button"
          aria-label="关闭侧栏遮罩"
          onClick={() => setMobileOpen(false)}
          className="fixed inset-0 z-30 bg-slate-900/40 backdrop-blur-[2px] lg:hidden"
        />
      ) : null}

      <div className="lg:pl-72">
        {/* 步骤 5：移动端顶栏（lg:hidden），菜单按钮开抽屉、Logo 用 compact 变体、右侧头像只做展示
            ——它没包 Dropdown，移动端要退出登录得先开侧栏 */}
        <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-line/80 bg-canvas/90 px-4 backdrop-blur lg:hidden">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            className="rounded-lg p-2 text-muted hover:bg-stone-200/60 hover:text-ink"
            aria-label="打开侧栏"
          >
            <Menu className="h-5 w-5" />
          </button>
          <Logo compact />
          <Avatar name={user.name} size="sm" />
        </header>

        {/* 步骤 5：正文容器，宽度上限 1440px 居中；子页面全靠这里的 <Outlet/> 渲染 */}
        <main className="mx-auto w-full max-w-[1440px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          <Outlet />
        </main>
      </div>

      {/* 步骤 6：新建知识库对话框，open 由 createOpen 驱动；创建成功即导航到新库的文档页 */}
      <CreateKbDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        orgId={org.id}
        onCreated={(kb) => navigate(`/orgs/${org.id}/kbs/${kb.id}/documents`)}
      />
    </div>
  );
}
