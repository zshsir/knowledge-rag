/**
 * 表单控件的皮肤层：Input、Textarea 两个受原生属性透传的控件，加一个把它们包起来的 Field 标签容器。
 * 边界：不做受控/非受控的取舍、不做校验、不生成 id——值与 onChange 由调用方接管，
 * 错误文案是否出现也由调用方决定，本文件只负责「长什么样 + 标签怎么关联」。
 * 调用方：features/** 的各表单（LoginPage、RegisterPage、OrgOnboardingPage、OrgSettingsPage、
 * CreateKbDialog、KbSettingsDialog、两个成员页）。
 */
import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

/**
 * Input 与 Textarea 共用的字段外观：圆角+描边+白底、字号、聚焦时的描边与柔光环、禁用态。
 * 之所以抽成一个常量：两个控件的这部分规则必须逐字一致，否则同一表单里并排的单行框和多行框会看起来不是一套。
 * 刻意不含高度与纵向内边距——那是每个控件自己补的几何量（见下面两处 cn 调用的第二个入参）。
 * 注意 Select 没有复用这张表，而是在 select.tsx 里另抄了一份近似规则（差异见那个文件头部）。
 */
const fieldClasses =
  'w-full rounded-xl border border-line bg-white px-3.5 text-sm text-ink outline-none transition placeholder:text-soft focus:border-accent/60 focus:ring-2 focus:ring-accent/15 disabled:cursor-not-allowed disabled:bg-stone-50';

/**
 * 单行输入框。
 * 步骤：把 fieldClasses 叠上 h-11（44px，够触屏点按）再叠调用方 className，其余属性全透传给原生 <input>。
 * forwardRef 保留给需要命令式聚焦的场景；目前站内没有调用方传 ref，对话框里的自动聚焦走的是
 * autoFocus 属性（CreateKbDialog.tsx:100）。
 */
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input ref={ref} className={cn(fieldClasses, 'h-11', className)} {...props} />
  ),
);
Input.displayName = 'Input';

/**
 * 多行输入框。
 * 步骤：同一张 fieldClasses，几何量换成 min-h-24 + py-3 + leading-relaxed（高度随内容撑开、有下限），
 * 并只允许纵向拉伸（resize-y），否则用户横向拖拽会撑破表单栅格布局。
 */
export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(fieldClasses, 'min-h-24 resize-y py-3 leading-relaxed', className)}
    {...props}
  />
));
Textarea.displayName = 'Textarea';

/**
 * 字段容器：把「标签 + 提示 + 控件 + 错误文案」按固定间距叠成一列。
 * 步骤：
 * 1. 渲染一行 label——左侧字段名、右侧可选的灰色 hint（如「1–60 字」这类约束提示），两者 baseline 对齐
 * 2. 原样渲染 children，控件本体由调用方决定放 Input / Textarea / Select 还是别的
 * 3. error 有值时补一行红字
 * 关联方式：本组件不渲染控件、也拿不到控件的 id，所以 label 与控件的绑定要靠调用方把同一个 id
 * 传两处（htmlFor={x} + <Input id={x}>）。站内 16 处调用中 15 处这么写，例如 LoginPage.tsx:67、
 * CreateKbDialog.tsx:92-98、OrgSettingsPage.tsx:81（唯一例外见下面第 60 行的已知缺口）。
 * 两处已知缺口（只记录，不改）：htmlFor 省略时 <label> 不带 for，点击标签不会聚焦控件
 * ——现存唯一一例是 KbMembersPage.tsx#KbMembersPage 里那个不带 htmlFor 的 `<Field label="权限">`
 * （当前在 KbMembersPage.tsx:545，那里 children 是一组自带 label 的权限卡片；用符号与字面量定位，
 * 别只信行号——同文件上方的行号已经漂过一次）；
 * 错误行只是普通文案，没接 aria-describedby / aria-invalid，读屏软件不会主动播报它。
 */
export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label
        htmlFor={htmlFor}
        className="flex items-baseline justify-between text-sm font-medium text-ink"
      >
        <span>{label}</span>
        {hint ? <span className="text-xs font-normal text-soft">{hint}</span> : null}
      </label>
      {children}
      {error ? <p className="text-xs text-red-600">{error}</p> : null}
    </div>
  );
}
