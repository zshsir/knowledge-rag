/**
 * 原生 <select> 的皮肤版：外观跟 Input/Textarea 对齐，箭头换成自己画的。
 * 边界：只处理单选下拉的显示，选项内容（<option>）由调用方作为 children 给；
 * 不实现可搜索/多选这类自定义下拉，因此值变化后的行为完全交给原生 select 与调用方的 onChange。
 * 调用方：两个成员授权对话框里的角色选择（KbMembersPage.tsx:455、OrgMembersPage.tsx:361 附近）。
 * 关于样式来源：本文件没有复用 input.tsx 的 fieldClasses（它是模块私有的），而是抄了一份等价规则，
 * 差别只有三处——加了 h-11 与 appearance-none、把 px-3.5 拆成 pl-3.5 + pr-9（给箭头让位）、
 * 去掉对 select 无意义的 placeholder:text-soft。今天两边一致，但改一处不会带动另一处，属于已知重复。
 */
import { forwardRef, type SelectHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../lib/cn';

/**
 * 下拉选择框。
 * 步骤：
 * 1. 外层 relative 的 div 只为给箭头做定位参照
 * 2. <select> 用 appearance-none 抹掉浏览器自带的箭头（各家画法不一，无法用 CSS 对齐），
 *    再用 pr-9 给右侧留出箭头的位置
 * 3. 叠一个绝对居中的 ChevronDown 当箭头，pointer-events-none 让点击穿透回 <select>——
 *    否则点箭头会落在 svg 上，原生的选项列表不会弹出
 * 注意：className 加在 <select> 上而不是外层 div 上，所以调用方传 w-full / 定位类改不了外壳宽度。
 */
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => (
    <div className="relative">
      <select
        ref={ref}
        className={cn(
          'h-11 w-full appearance-none rounded-xl border border-line bg-white pl-3.5 pr-9 text-sm text-ink outline-none transition focus:border-accent/60 focus:ring-2 focus:ring-accent/15 disabled:cursor-not-allowed disabled:bg-stone-50',
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-soft" />
    </div>
  ),
);
Select.displayName = 'Select';
