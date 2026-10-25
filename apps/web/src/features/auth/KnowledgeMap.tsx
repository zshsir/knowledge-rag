/**
 * 认证页左栏的「知识闭环」示意图：中心是 Atlas（RAG core），四个卫星节点按
 * 上=文档、右=向量、下=检索、左=引用 顺时针排布，用 SVG 的同心虚线圈 + 十字连线把节点连回中心。
 *
 * 结构与响应式：
 * - 容器是一个正方形（aspect-square）+ 宽度上限，自身不写死像素：宽窄完全由父级盒子决定。
 *   同一组件被 AuthLayout 放了两处（内嵌窄版 / 2xl 的独立演示列），靠父级限宽适配，不靠断点分叉
 * - 四个节点的位置是「绝对定位 + 50% 锚点 + 位移」，所以尺寸变化时始终贴着圆环的四等分点，
 *   不需要按容器大小重算坐标；SVG 用固定 viewBox="0 0 360 360" 等比缩放，因此线和点永远对齐
 * - 中心光晕、四道同心圆环（2 个 CSS 环 + 2 个 SVG 圈）、连线与四个端点圆全部是纯装饰，
 *   没有数据绑定，也不可交互
 *
 * 边界：只渲染图形，不读取任何业务状态；对屏幕阅读器隐藏（aria-hidden），
 * 真实信息由右侧表单与文案承担，避免读屏器把装饰性英文标签念成产品信息。
 */
import {
  Database,
  FileText,
  Layers3,
  Quote,
  Search,
  type LucideIcon,
} from 'lucide-react';

// 四个卫星节点：position 是相对容器的锚点类（内含 -translate-* 把自身中心对到圆环上），
// 顺序即「文档 → 向量 → 检索 → 引用」的视觉顺时针顺序（从上方开始）
const nodes: Array<{
  icon: LucideIcon;
  label: string;
  caption: string;
  position: string;
}> = [
  {
    icon: FileText,
    label: '文档',
    caption: 'TXT · PDF',
    position: 'left-1/2 top-0 -translate-x-1/2',
  },
  {
    icon: Database,
    label: '向量',
    caption: '1024 维',
    position: 'right-0 top-1/2 -translate-y-1/2',
  },
  {
    icon: Search,
    label: '检索',
    caption: 'Top-K',
    position: 'bottom-0 left-1/2 -translate-x-1/2',
  },
  {
    icon: Quote,
    label: '引用',
    caption: '可溯源',
    position: 'left-0 top-1/2 -translate-y-1/2',
  },
];

export function KnowledgeMap() {
  return (
    <div className="relative mx-auto aspect-square w-full max-w-[320px]" aria-hidden="true">
      <div className="absolute left-1/2 top-1/2 h-44 w-44 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[conic-gradient(from_180deg,rgba(99,102,241,0.55),rgba(34,211,238,0.25),rgba(99,102,241,0.55))] opacity-50 blur-2xl" />
      <div className="absolute inset-[8%] rounded-full border border-white/[0.05]" />
      <div className="absolute inset-[20%] rounded-full border border-dashed border-white/[0.08]" />

      <svg viewBox="0 0 360 360" className="pointer-events-none absolute inset-0 h-full w-full">
        <defs>
          <linearGradient id="premium-line" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#818cf8" stopOpacity="0.9" />
            <stop offset="100%" stopColor="#22d3ee" stopOpacity="0.3" />
          </linearGradient>
        </defs>
        <circle cx="180" cy="180" r="126" fill="none" stroke="url(#premium-line)" strokeWidth="1.4" strokeDasharray="4 9" />
        <circle cx="180" cy="180" r="92" fill="none" stroke="rgba(129,140,248,0.16)" strokeWidth="1" />
        <line x1="180" y1="180" x2="180" y2="38" stroke="url(#premium-line)" strokeWidth="1" strokeDasharray="3 6" />
        <line x1="180" y1="180" x2="322" y2="180" stroke="url(#premium-line)" strokeWidth="1" strokeDasharray="3 6" />
        <line x1="180" y1="180" x2="180" y2="322" stroke="url(#premium-line)" strokeWidth="1" strokeDasharray="3 6" />
        <line x1="180" y1="180" x2="38" y2="180" stroke="url(#premium-line)" strokeWidth="1" strokeDasharray="3 6" />
        <circle cx="180" cy="38" r="3" fill="#a5b4fc" />
        <circle cx="322" cy="180" r="3" fill="#67e8f9" />
        <circle cx="180" cy="322" r="3" fill="#a5b4fc" />
        <circle cx="38" cy="180" r="3" fill="#67e8f9" />
      </svg>

      <div className="absolute left-1/2 top-1/2 flex h-24 w-24 -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center rounded-[1.8rem] border border-white/15 bg-[#101828]/90 shadow-2xl shadow-indigo-950/60 backdrop-blur-xl">
        <div className="absolute inset-x-3 top-0 h-px bg-gradient-to-r from-transparent via-indigo-300/60 to-transparent" />
        <Layers3 className="h-5 w-5 text-indigo-200" strokeWidth={1.8} />
        <span className="mt-1.5 text-sm font-semibold tracking-tight text-white">Atlas</span>
        <span className="text-[8px] font-medium uppercase tracking-[0.25em] text-slate-500">
          RAG core
        </span>
      </div>

      {nodes.map((node) => (
        <div
          key={node.label}
          className={`absolute ${node.position} flex items-center gap-2 rounded-2xl border border-white/10 bg-[#101828]/90 px-3 py-2 shadow-lg shadow-black/30 backdrop-blur-md`}
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500/40 to-indigo-400/10 text-indigo-200 ring-1 ring-inset ring-white/10">
            <node.icon className="h-3.5 w-3.5" />
          </span>
          <span>
            <span className="block text-[11px] font-medium leading-tight text-white">
              {node.label}
            </span>
            <span className="mt-0.5 block text-[8px] leading-none tracking-wide text-slate-500">
              {node.caption}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}
