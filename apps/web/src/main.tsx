/**
 * 前端唯一入口：把整棵 React 树挂到 index.html 的容器上（index.html:10 的 <div id="root">，
 * 由 index.html:11 的 <script type="module" src="/src/main.tsx"> 引到本文件）。
 * 步骤：
 * 1. createRoot 取容器并做非空断言——容器缺失属于构建/模板问题，不是运行时会出现的状态
 * 2. StrictMode 只在开发期生效：effect 会被双跑一遍，用来暴露「副作用没写清理」。
 *    lib/socket.tsx 里建立/关闭 Socket.IO 连接的那个 effect 正是会被双跑的一类，
 *    它的 cleanup 会 off 监听并 close()，所以双跑不会留下两条连接
 * 3. Providers（app/providers.tsx）套全局依赖，顺序有约束：QueryClientProvider → BrowserRouter
 *    → ToastProvider → AuthProvider → SocketProvider——SocketProvider 要读 useAuth，
 *    AuthProvider 要用 useQueryClient，用 useToast 的组件必须在路由里
 * 4. App（app/App.tsx）只装路由表，鉴权与页面都在它下面
 * 边界：本文件不发请求、不做鉴权、不读环境变量（API 基址在 lib/api.ts:23，
 * WS 基址靠同源默认值）；下面那行 CSS import 是全应用唯一的样式入口，
 * Tailwind v4 由 vite.config.ts:6 的插件处理，仓库里没有 postcss 配置。
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { Providers } from './app/providers';
// 步骤 4 之前的样式副作用：必须由入口引一次，Tailwind 才会扫到并打出用到的工具类
import './styles/index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Providers>
      <App />
    </Providers>
  </StrictMode>,
);
