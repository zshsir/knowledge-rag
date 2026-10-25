/**
 * 状态页：一张共用的排版壳 + 两个对外页面（403 / 404）。
 * 职责：纯展示，把「进不去/找不到」画出来，并给一个回工作区的入口。
 * 不做什么：不发请求、不读任何查询数据、不判断权限——谁该显示 403 由调用方决定；
 *      也不改浏览器历史、不做自动跳转。
 * 关于 code 这个 prop：它是写死的展示文案（'403' / '404'），跟真实 HTTP 状态码没有对应关系——
 *      这两页都是 SPA 前端渲染出来的，服务器返回的始终是 index.html。
 * 现役挂载点：App.tsx 的 <Route path="*" element={<NotFoundPage />} />，
 *      它是 ProtectedRoute 那条布局路由的**兄弟**节点，所以未登录的人打错 URL 直接看到 404 页，
 *      不会被送去 /login（这是现状描述，不是缺陷判断）。
 * 未接线的导出：ForbiddenPage 目前在全仓库只有这一处定义、没有任何 import
 *      （apps/web 下 `grep -rn ForbiddenPage src` 只命中本文件），
 *      后端 403 的响应由各页面自己的错误分支渲染；留着它是给后续统一 403 页用。
 */
import { Link } from 'react-router-dom';
import { ArrowLeft, LockKeyhole, SearchX } from 'lucide-react';
import { Button, buttonClasses } from '../components/ui/button';
import { Logo } from '../components/ui/logo';

/**
 * 共用的排版壳（本文件私有，不导出）。
 * 步骤：
 * 1. 外层 min-h-screen 居中铺满，底色 bg-canvas，顶部放 Logo（与 AuthLayout、OrgOnboardingPage 同一个组件）
 * 2. 卡片：图标块 → code 小字 → title 大标题 → description 说明，全部居中
 * 3. 底部一个用 buttonClasses 化装成按钮的 <Link to="/">，文案固定「返回工作区」，
 *    点它走的是 HomeRedirect 的分流逻辑，所以这里不需要知道该去哪个 org
 * 四个入参都只是文案/节点，没有任何分支逻辑：要加新状态页就再包一层调用本组件的导出函数。
 * 注：这里不用 Button 组件，因为要渲染的是 <Link>——buttonClasses 就是为这种场景导出的
 *     （同一用法见 components/ui/button.tsx 的头注释与 JoinPage）。
 *     文件顶部那行 import 里的 Button 在本文件没有任何使用点（现状是死导入，
 *     tsconfig 没开 noUnusedLocals 所以 tsc 不报；本提交是纯注释，不删它）。
 */
function StatusShell({
  icon,
  code,
  title,
  description,
}: {
  icon: React.ReactNode;
  code: string;
  title: string;
  description: string;
}) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-canvas px-6">
      <Logo />
      <div className="mt-10 w-full max-w-md rounded-3xl border border-line bg-white p-8 text-center shadow-sm">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-soft text-accent">
          {icon}
        </div>
        <p className="mt-5 text-xs font-semibold uppercase tracking-[0.2em] text-soft">{code}</p>
        <h1 className="mt-2 text-xl font-semibold tracking-tight text-ink">{title}</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">{description}</p>
        <Link to="/" className={buttonClasses('primary', 'md', 'mt-6 w-full')}>
          <ArrowLeft className="h-4 w-4" />
          返回工作区
        </Link>
      </div>
    </div>
  );
}

/**
 * 403 页：只把图标/文案换掉，排版全交给 StatusShell。
 * 说明文案里点明了两种授权来源——组织角色（memberships.role）与知识库授权
 * （knowledge_base_members），与服务端 KbPermissionGuard 解析权限的两条路径对应；
 * 但本页自己不判断任何一种，谁渲染它谁负责已经判过。
 * 现状：没有任何调用方（见文件头「未接线的导出」）。
 */
export function ForbiddenPage() {
  return (
    <StatusShell
      icon={<LockKeyhole className="h-6 w-6" />}
      code="403"
      title="没有访问权限"
      description="你当前的组织角色或知识库授权不允许访问此页面。请联系组织管理员。"
    />
  );
}

/**
 * 404 页：App.tsx 里 `path="*"` 的兜底，凡是路由表匹配不上的 URL 都落到这里。
 * 只覆盖「前端路由表里没有这条路径」这一种 404；接口返回的 404（比如读到别人的会话、
 * 非成员访问组织）由各页面自己的错误分支显示，不会渲染本页。
 */
export function NotFoundPage() {
  return (
    <StatusShell
      icon={<SearchX className="h-6 w-6" />}
      code="404"
      title="页面不存在"
      description="链接可能已失效，或者资源已被删除。"
    />
  );
}
