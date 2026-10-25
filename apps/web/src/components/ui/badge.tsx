/**
 * 小标签（状态胶囊）：一组固定的语义色调，用于文档状态、权限、访问模式这类枚举值。
 * 边界：它不认识任何业务枚举——「哪种状态该用哪种 tone」由调用方决定，
 * 文档状态的映射表就单独放在 features/documents/StatusBadge.tsx 而不是塞进这里。
 * 调用方：StatusBadge、ChatPage、DocumentsPage、KbLayout、KbMembersPage、OrgMembersPage、OrgHomePage、
 * OrgSettingsPage。
 */
import { cn } from '../../lib/cn';

/** 六种色调：5 种实底 + outline（透明底描边）；outline 用于不承载好坏语义的中性信息（计数、权限名称） */
type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'indigo' | 'outline';

const tones: Record<Tone, string> = {
  neutral: 'bg-stone-100 text-stone-600 border-stone-200',
  success: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  warning: 'bg-amber-50 text-amber-700 border-amber-200',
  danger: 'bg-red-50 text-red-700 border-red-200',
  indigo: 'bg-accent-soft text-accent border-indigo-200',
  outline: 'bg-transparent text-muted border-line',
};

/**
 * 渲染一枚胶囊标签。
 * 步骤：
 * 1. 由 tone 查配色表，叠加在固定的圆角/内边距/字号打底之上，最后叠调用方 className
 * 2. dot 为真时在文字前插一个小圆点
 * 3. children 原样作为文字输出
 * 两处刻意的设计：
 * - 圆点用 bg-current，也就是直接继承当前文字颜色，因此不用为六种 tone 再维护第二张圆点配色表；
 *   压到 70% 不透明度是为了让它读起来像装饰而不是主体
 * - 语义只由 children 的文字承载，颜色只是强化。所以状态标签必须写文字，
 *   不能只靠 tone 区分（色盲与读屏用户拿不到颜色信息）
 */
export function Badge({
  children,
  tone = 'neutral',
  className,
  dot = false,
}: {
  children: React.ReactNode;
  tone?: Tone;
  className?: string;
  dot?: boolean;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium',
        tones[tone],
        className,
      )}
    >
      {dot ? <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" /> : null}
      {children}
    </span>
  );
}
