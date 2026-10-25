/**
 * 按钮皮肤：五种语义 variant × 四种尺寸，加上带 loading 态的 <Button> 组件。
 * 边界：只管外观与「按下时禁用」这一条交互，不含提交逻辑、不含权限判断，也不做防抖；
 * 点击后做什么完全由调用方的 onClick / type=submit 决定。
 * 调用方：features/** 与 app/** 全站；同一套皮肤也提供给非 <button> 元素（见 buttonClasses）。
 */
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '../../lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'soft';
type Size = 'sm' | 'md' | 'lg' | 'icon';

/** 语义 → 配色。primary 是唯一以品牌色（accent）铺底的实心档；danger 也是实心白字但固定用红色，专用于不可撤销操作的确认按钮 */
const variants: Record<Variant, string> = {
  primary:
    'bg-accent text-white shadow-sm shadow-indigo-900/20 hover:bg-accent-dark active:bg-indigo-800',
  secondary:
    'border border-line bg-white text-ink shadow-sm hover:border-line-strong hover:bg-stone-50',
  ghost: 'text-muted hover:bg-stone-100 hover:text-ink',
  danger: 'bg-red-600 text-white shadow-sm hover:bg-red-700',
  soft: 'bg-accent-soft text-accent hover:bg-indigo-100',
};

/** 尺寸 → 高度/内边距。icon 是唯一的正方形档（h-9 w-9 + p-0），给纯图标按钮用 */
const sizes: Record<Size, string> = {
  sm: 'h-9 rounded-lg px-3 text-xs',
  md: 'h-10 rounded-xl px-4 text-sm',
  lg: 'h-11 rounded-xl px-5 text-sm',
  icon: 'h-9 w-9 rounded-lg p-0',
};

/**
 * 拼出按钮类名，供 <Button> 内部使用，也导出来给不能渲染成 <button> 的元素复用同一张皮肤。
 * 步骤：
 * 1. 打底（布局、gap、focus-visible 焦点环、disabled 半透明且不吃事件）
 * 2. 叠加 variant 与 size 两张表
 * 3. 最后叠加调用方 className，交给 cn() 做冲突消解，保证自定义能覆盖内置
 * 复用示例：JoinPage.tsx:96 与 StatusPages.tsx:27 把 <Link> 化装成按钮，
 * OrgHomePage.tsx:158 给裸 <button> 用。注意走这条路就没有 loading 态——转圈与禁用要自己实现。
 */
export function buttonClasses(
  variant: Variant = 'primary',
  size: Size = 'md',
  className?: string,
): string {
  return cn(
    'inline-flex select-none items-center justify-center gap-2 whitespace-nowrap font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/40 disabled:pointer-events-none disabled:opacity-50',
    variants[variant],
    sizes[size],
    className,
  );
}

/** 继承原生 button 的全部属性，因此 type / form / aria-* 都由调用方自己传（本组件不给默认值） */
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

/**
 * 按钮组件。
 * 步骤：
 * 1. className 经 buttonClasses 拼皮肤，其余原生属性原样透传
 * 2. disabled = 调用方的 disabled 或 loading，所以 loading 期间自动吃不了点击，
 *    调用方因此不必在 onClick 里自己判 pending（代码只保证这一条：loading 到 disabled 的映射）
 * 3. loading 时在文案前插一个转圈图标；文案本身不隐藏，配合打底的 gap-2 与 whitespace-nowrap，
 *    切换 loading 不会让按钮宽度大幅跳动
 * 提醒：<Button> 不设默认 type，而 HTML 里 <button> 不写 type 的默认值就是 submit，
 * 所以放进 <form> 的按钮天然会提交（LoginPage.tsx:102 显式写 type="submit"、
 * CreateKbDialog.tsx:67-69 用 type="submit" + form={formId} 挂回对话框外的表单），
 * 只想触发动作的场景必须自己写 type="button"。
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant = 'primary',
      size = 'md',
      loading = false,
      disabled,
      children,
      ...props
    },
    ref,
  ) => (
    <button
      ref={ref}
      className={buttonClasses(variant, size, className)}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
      {children}
    </button>
  ),
);

// forwardRef 返回的是匿名函数，不写 displayName 的话 React DevTools 里只会显示为「Unknown」
Button.displayName = 'Button';
