/**
 * 单条引用来源卡片：折叠时显示序号、文件名与相似度百分比，点击展开原文片段。
 *
 * 字段含义（对应 lib/types.ts 的 Source，后端 chat/sources.ts 产出）：
 * - index：本次回答内的引用编号（不是分片序号），展示为左侧小方块
 * - chunkIndex：该片段在文档内的分片下标，展示时 +1 变成人类可读的「第几段」
 * - score：余弦相似度，展示前先夹到 [0,1] 再四舍五入成百分比；展开后另存三位小数原值
 * 边界：展开状态是组件本地 state，不请求额外数据——片段正文在 chat:meta 时已随来源下发。
 */
import { useState } from 'react';
import { ChevronDown, FileText } from 'lucide-react';
import type { Source } from '../../lib/types';
import { cn } from '../../lib/cn';

/** 引用卡片；同一段正文在展开前后只切换可见性，不重新取数 */
export function SourceCard({ source }: { source: Source }) {
  const [open, setOpen] = useState(false);
  // 百分比用于紧凑展示；后端评分已在 0–1，但这里仍夹一次，避免脏数据让宽度/文案异常
  const score = Math.round(Math.min(1, Math.max(0, source.score)) * 100);

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-stone-50/60">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left outline-none transition hover:bg-stone-100/70"
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-white text-[10px] font-semibold text-accent ring-1 ring-indigo-100">
          {source.index}
        </span>
        <FileText className="h-3.5 w-3.5 shrink-0 text-soft" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink">
          {source.filename}
        </span>
        <span className="shrink-0 text-[10px] text-soft">{score}%</span>
        <ChevronDown
          className={cn('h-3.5 w-3.5 shrink-0 text-soft transition', open && 'rotate-180')}
        />
      </button>
      {open ? (
        <div className="border-t border-line/80 px-3.5 py-3 text-xs leading-relaxed text-muted">
          <p className="whitespace-pre-wrap">{source.content}</p>
          <p className="mt-2 text-[10px] text-soft">
            片段 {source.chunkIndex + 1} · 相似度 {source.score.toFixed(3)}
          </p>
        </div>
      ) : null}
    </div>
  );
}
