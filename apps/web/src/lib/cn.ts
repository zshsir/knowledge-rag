/**
 * 组件类名的拼装工具：条件加类 + Tailwind 冲突消解，全站组件统一走这一个函数。
 * 边界：只做字符串运算，不含组件、不读样式表；界面里的自定义色名（text-ink、bg-canvas 等）
 * 来自 styles/index.css 的 @theme 声明，本文件不需要为它们做任何配置。
 * 调用方：components/ui/** 与 features/** 的组件，典型用法见 app/AppShell.tsx 与
 * features/knowledge-bases/KbLayout.tsx:36-42 的 tabClass。
 */
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * 把任意个类名入参合成一个字符串。
 * 步骤：
 * 1. clsx 先把字符串、false/undefined/null、对象这些入参收敛成一个类名字符串
 *    （所以 `cn('a', cond && 'b')` 这种写法能直接条件加类）
 * 2. twMerge 再按 Tailwind 的语义分组去重：同一组（比如都设内边距）只留最后出现的那个
 * 为什么第 2 步不能省：光靠 clsx，'px-2' 和 'px-4' 会同时留在 class 里，谁生效取决于样式表里
 * 谁的规则排在后面，表现就是「调用方传进来的类覆盖不掉组件自带样式」；合并后覆盖关系才是可预期的。
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
