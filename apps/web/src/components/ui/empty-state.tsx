/**
 * 空状态占位块：列表/工作区没有内容时显示的「图标 + 标题 + 说明 + 可选操作」居中卡片。
 * 边界：不判断「是否为空」（该不该显示由调用方的数据状态决定），也不发起任何请求；
 * action 是一个插槽，本文件不认识里面放的是按钮还是链接。
 * 调用方：DocumentsPage.tsx:328（还没有文档）、OrgHomePage.tsx:150（还没有知识库）。
 */
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/cn';

/**
 * 空状态块。
 * 步骤：
 * 1. 外层给一个虚线描边 + 半透明白底的容器，让它读起来像「预留的位置」而不是一张真内容卡片
 * 2. 顶部色块里渲染图标，下面依次是标题、可选说明、可选操作区
 * 3. description / action 缺省时整行不渲染（不留空白高度）
 * icon 收的是组件本身（LucideIcon）而不是元素，这样尺寸和描边颜色由本文件统一管，
 * 调用方只写 `icon={FileText}`；标题用 h3，前提是页面里已经有 h1/h2 在上层。
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-2xl border border-dashed border-line bg-white/60 px-6 py-14 text-center',
        className,
      )}
    >
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-accent">
        <Icon className="h-6 w-6" />
      </div>
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      {description ? (
        <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-muted">{description}</p>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
