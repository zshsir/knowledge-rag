/**
 * 前端路由表：全站唯一的一份 URL → 组件映射，由 src/main.tsx 挂进 Providers。
 * 结构分三段，从上到下就是权限强弱：
 * 1. 公开页：/login、/register、/join/:token —— 刻意放在 ProtectedRoute 之外，
 *    未登录必须打得开（JoinPage 对未登录的人渲染「登录后加入 / 创建账号并加入」两个链接，
 *    自己不跳 /login，所以这条路由不能受保护）
 * 2. 受保护树：外层 <Route element={<ProtectedRoute />}> 没有 path，只做「登录了才放行」的判断，
 *    里面才是真页面；'/' 交给 HomeRedirect 分流，/orgs/new 是建组织引导页，
 *    /orgs/:orgId 这层是 AppShell（侧栏 + <Outlet/>），它的子路由 index/members/settings 与
 *    kbs/:kbId（KbLayout）都用相对路径，展开后是 /orgs/{orgId}/... 与 /orgs/{orgId}/kbs/{kbId}/...
 *    其中 kbs/:kbId 的 index 是一条相对重定向 <Navigate to="chat" replace/>，所以进库默认落在对话页
 * 3. 兜底：path="*" 的 NotFoundPage，它与 ProtectedRoute 那条是兄弟节点，因此未登录打错 URL
 *    看到的是 404 页而不是登录页
 * 职责边界：本文件只有映射——不发请求、不判登录态（ProtectedRoute）、不判组织归属（AppShell）、
 *      不写布局样式（AppShell / KbLayout）、也不做懒加载分包（全站一个 bundle，没 React.lazy）。
 * 唯一带逻辑的节点是下面的 KbChatRoute：切知识库时的状态重置靠它的 key，别动。
 */
import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { ProtectedRoute } from './ProtectedRoute';
import { HomeRedirect } from './HomeRedirect';
import { NotFoundPage } from './StatusPages';
import { AppShell } from './AppShell';
import { LoginPage } from '../features/auth/LoginPage';
import { RegisterPage } from '../features/auth/RegisterPage';
import { JoinPage } from '../features/auth/JoinPage';
import { OrgOnboardingPage } from '../features/organizations/OrgOnboardingPage';
import { OrgHomePage } from '../features/knowledge-bases/OrgHomePage';
import { OrgMembersPage } from '../features/organizations/OrgMembersPage';
import { OrgSettingsPage } from '../features/organizations/OrgSettingsPage';
import { KbLayout } from '../features/knowledge-bases/KbLayout';
import { DocumentsPage } from '../features/documents/DocumentsPage';
import { ChatPage } from '../features/chat/ChatPage';
import { KbMembersPage } from '../features/knowledge-bases/KbMembersPage';

/**
 * 对话路由外壳：给 ChatPage 一个由 kbId 派生的 key，切知识库时强制卸载重建（BUG-2 修复）。
 *
 * 缺陷背景：本文件对所有 :kbId 复用同一个路由元素，ChatPage 在侧栏从 A 库切到 B 库时
 * 不会卸载；而它内部的 activeId（当前会话）、流式 reducer、输入框等状态只随组件生命周期
 * 重置。于是 B 库会沿用 A 库的 activeId，消息查询（键里没有 kbId）继续渲染 A 的历史，
 * 发送时也会带上 A 的会话 id，被服务端按 kbId 校验后返回 404（表现为 chat:error）。
 *
 * 为什么用 key 而不是在 ChatPage 里写重置 effect：key 变化会让 React 直接丢弃旧实例、
 * 重建全部状态，任何现在或将来新增的组件内状态都会被一并清掉，不依赖某个人记得补重置；
 * 同时旧实例的 socket 订阅会在卸载清理里退订，在途流不会串到新库。
 * 切勿删掉 key 或改回 <Route path="chat" element={<ChatPage />} />，那会重新引入跨库串状态。
 */
function KbChatRoute() {
  const { kbId } = useParams();
  return <ChatPage key={kbId} />;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/join/:token" element={<JoinPage />} />

      <Route element={<ProtectedRoute />}>
        <Route path="/" element={<HomeRedirect />} />
        <Route path="/orgs/new" element={<OrgOnboardingPage />} />
        <Route path="/orgs/:orgId" element={<AppShell />}>
          <Route index element={<OrgHomePage />} />
          <Route path="members" element={<OrgMembersPage />} />
          <Route path="settings" element={<OrgSettingsPage />} />
          <Route path="kbs/:kbId" element={<KbLayout />}>
            <Route index element={<Navigate to="chat" replace />} />
            {/* 经外壳渲染，借 key={kbId} 保证切库即重建对话页状态（见 KbChatRoute 注释） */}
            <Route path="chat" element={<KbChatRoute />} />
            <Route path="documents" element={<DocumentsPage />} />
            <Route path="members" element={<KbMembersPage />} />
          </Route>
        </Route>
      </Route>

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
