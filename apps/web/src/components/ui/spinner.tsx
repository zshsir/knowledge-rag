/**
 * 加载指示：一个小转圈 + 一个整页级的加载占位块。
 * 边界：不发请求、不订阅任何数据状态，纯展示；「什么时候算加载中」由调用方（多用 react-query 的
 * isLoading / isPending）决定。两者区别只在尺寸——页面级用 PageLoader，按钮内联那种请直接用
 * components/ui/button.tsx 的 loading 属性，不要在这里再造一个圈。
 * 调用方：Spinner 见 JoinPage.tsx:36、DocumentsPage.tsx:54；PageLoader 见 ProtectedRoute.tsx:9、
 * HomeRedirect.tsx:7 与各 feature 页面的 isLoading 分支。
 */
import { Loader2 } from 'lucide-react';
import { cn } from '../../lib/cn';

/**
 * 转圈图标本体。
 * 默认 h-5 w-5 + 主色，className 排在 cn() 最后所以调用方可覆盖尺寸与颜色
 * （PageLoader 下面就用 className="h-6 w-6" 把它放大了一档）。
 */
export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('h-5 w-5 animate-spin text-accent', className)} />;
}

/**
 * 整页加载占位：垂直居中的转圈加一行中文说明。
 * 步骤：
 * 1. h-full 撑满父容器，min-h-[320px] 保证父容器高度还没定下来时也不会塌成一条
 * 2. 复用 Spinner 并放大到 h-6 w-6
 * 3. 文案由 label 传入，默认「加载中…」；调用方一般会给更具体的（"正在加载成员…"），
 *    这样用户在等待时知道自己在等什么
 * 注意它只画 loading，不含 error / 空状态的分支——那两个分支各页面自己写，见 AppShell.tsx:50-56
 * 的「加载失败，点击重试」与 empty-state.tsx。
 */
export function PageLoader({ label = '加载中…' }: { label?: string }) {
  return (
    <div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-3 text-sm text-muted">
      <Spinner className="h-6 w-6" />
      <span>{label}</span>
    </div>
  );
}
