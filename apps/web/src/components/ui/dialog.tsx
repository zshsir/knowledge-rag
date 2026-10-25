/**
 * 模态对话框外壳：用原生 <dialog> + showModal 提供「标题 / 描述 / 正文插槽 / 底部按钮区」这套骨架。
 * 边界：它刻意不含任何业务与表单逻辑，也不自己决定关闭结果——Esc、点空白、右上角关闭按钮三条路径
 * 全部只调用 onClose，真正的开关由父组件的 open state 决定（受控组件）。
 * 调用方：components/ui/confirm-dialog.tsx，以及 features/** 里的 CreateKbDialog、KbSettingsDialog、
 * OrgMembersPage、KbMembersPage。
 *
 * 两个必须留意的布局坑（第一个漏写，UA 的居中样式被 preflight 覆盖后对话框必然贴左上角）：
 * 1. m-auto 不能省。原生 dialog 模态时靠浏览器 UA 样式的 position:fixed + inset:0 + margin:auto 居中，
 *    而 Tailwind 4 的 preflight 用 `*{margin:0}` 把 margin:auto 覆盖掉了
 *    （node_modules/tailwindcss/preflight.css:7-16），居中依赖就此消失；
 *    所以这里必须显式写 m-auto 把它补回来，删掉后对话框会贴左上角。
 * 2. max-h-[calc(100dvh-2rem)] + overflow-hidden 是防溢出的组合：外层高度封顶在「视口高度减去上下各
 *    1rem 留白」，正文另自 max-h-[65vh] overflow-y-auto 承担滚动；overflow-hidden 保证超出外层上限的
 *    内容被裁掉而不是画出屏幕，同时让 header/footer 的背景被 rounded-2xl 的圆角裁圆。
 *    宽度同理由 w-[calc(100vw-2rem)]（窄屏贴边留 1rem）与 sizes 表的 max-w-*（宽屏封顶）共同决定。
 */
import { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';
import { cn } from '../../lib/cn';

/** 宽度档位：只影响 max-width；高度上限与滚动规则见文件头第 2 点 */
const sizes = {
  sm: 'max-w-md',
  md: 'max-w-xl',
  lg: 'max-w-3xl',
};

/**
 * 受控模态对话框。
 * 步骤：
 * 1. effect 监听 open，把 React 状态翻译成原生 dialog 的 showModal()/close()
 * 2. 渲染 <dialog>：标题区（含右上角关闭按钮）+ 可滚动正文 + 可选 footer 区
 * 3. 关闭路径统一收敛到 onClose：Esc 走 cancel 事件、点对话框自身空白走 click 事件、
 *    右上角按钮直接调用
 * 说明：footer 与 children 是兄弟节点，所以放在 footer 里的提交按钮要靠 HTML 的 form 属性挂回
 * children 里的 <form>，典型写法见 CreateKbDialog.tsx:67-74（type="submit" + form={formId}）。
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: keyof typeof sizes;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // 步骤 1：useId 生成标题 id，供 aria-labelledby 关联——原生 dialog 没有语义上的标题绑定方式
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    // 步骤 2：把 open 翻译成原生 API。`!dialog.open` 这层判断是必需的：按规范对已经打开的 dialog
    // 再调 showModal() 会抛 InvalidStateError；而 open 未变化时 effect 不重跑，重复调用也就被挡住
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      // 步骤 3a：Esc 触发 cancel 事件，浏览器默认会原生关闭对话框。这里必须 preventDefault，
      // 否则父组件的 open 仍停在 true、effect 不会再触发，弹窗会陷入「已经看不见但再也打不开」的状态
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      // 步骤 3b：事件目标恰好是 <dialog> 自身（即点在 header/正文/footer 三个 div 之外的盒面）时视为点外部关闭
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
      className={cn(
        'm-auto max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-line bg-surface p-0 text-ink shadow-2xl shadow-slate-900/20 backdrop:bg-slate-900/45',
        sizes[size],
      )}
    >
      <div className="flex items-start justify-between gap-4 border-b border-line px-6 py-5">
        <div>
          <h2 id={titleId} className="text-base font-semibold tracking-tight">
            {title}
          </h2>
          {description ? (
            <p className="mt-1 text-sm leading-relaxed text-muted">{description}</p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg p-1.5 text-soft outline-none transition hover:bg-stone-100 hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-label="关闭"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="max-h-[65vh] overflow-y-auto px-6 py-5">{children}</div>
      {footer ? (
        <div className="flex items-center justify-end gap-2 border-t border-line bg-stone-50/60 px-6 py-4">
          {footer}
        </div>
      ) : null}
    </dialog>
  );
}
