/**
 * 文档入库状态 → 中文徽标。状态集合与后端 documents.repository.ts 的 DocumentStatus 一致：
 * queued / processing / ready / failed，四个分支按此顺序判断，最后一条兜底即 failed。
 *
 * 边界：纯展示映射，不轮询、不改变状态；状态推进由后端的队列与 WebSocket 推送负责，
 * 断线时由 DocumentsPage 的轮询兜底刷新。
 */
import { AlertCircle, CheckCircle2, Clock3, Loader2 } from 'lucide-react';
import { Badge } from '../../components/ui/badge';
import type { DocumentStatus } from '../../lib/types';

/** 渲染状态徽标；processing 的图标带旋转动画，其余是静态图标 */
export function DocumentStatusBadge({ status }: { status: DocumentStatus }) {
  if (status === 'queued') {
    return (
      <Badge tone="neutral">
        <Clock3 className="h-3 w-3" />
        排队中
      </Badge>
    );
  }
  if (status === 'processing') {
    return (
      <Badge tone="indigo">
        <Loader2 className="h-3 w-3 animate-spin" />
        处理中
      </Badge>
    );
  }
  if (status === 'ready') {
    return (
      <Badge tone="success">
        <CheckCircle2 className="h-3 w-3" />
        已就绪
      </Badge>
    );
  }
  return (
    <Badge tone="danger">
      <AlertCircle className="h-3 w-3" />
      失败
    </Badge>
  );
}
