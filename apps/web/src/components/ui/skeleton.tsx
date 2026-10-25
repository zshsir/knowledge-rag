/**
 * 骨架屏的一块灰斑：加载中的数据占位，用同尺寸的方块提前占住布局，避免内容到位时页面跳动。
 * 边界：一个文件就一个组件，没有尺寸档位、没有排列组合、也不判断该显示几块——
 * 要几条、什么形状全部由调用方的 className 决定，所以本文件只有外观这一件事，
 * 按三层注释的尺度它只需要这一句头注释加下面一行说明，不必凑步骤。
 * 调用方：AppShell.tsx:47（侧边栏知识库列表 3 条 h-9）、OrgHomePage.tsx:136（卡片网格里的 h-56 卡片）。
 */
import { cn } from '../../lib/cn';

/**
 * 灰斑本体。
 * 注意 div 没有任何自带尺寸（没有 w/h），所以调用方必须传 className 给出高度，否则渲染成 0 高的不可见元素；
 * bg-stone-200/70 的 70% 不透明度让它在深浅两种底上都只是「淡淡的灰」，不与真实内容卡片抢层次。
 */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-lg bg-stone-200/70', className)} />;
}
