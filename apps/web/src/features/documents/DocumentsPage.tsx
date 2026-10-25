/**
 * 文档页：上传、列表、展开查看分段、失败重试、删除。
 *
 * 数据与实时性：
 * - 列表缓存键 ['documents', orgId, kbId]；展开的分段单独用 ['document-chunks', orgId, documentId]
 * - 状态变化的实时推送由 KbLayout 统一订阅 document:status 并失效列表缓存；
 *   本页只在 socket 断线且存在 queued/processing 文档时，用 5 秒轮询兜底
 * - 权限：kb.effectivePermission === 'viewer' 时只读（不能上传/重试/删除）；
 *   真正的执法点是后端 KbPermissionGuard 与 service 层现判，这里只是界面收敛
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  ChevronDown,
  Download,
  FileText,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { ConfirmDialog } from '../../components/ui/confirm-dialog';
import { EmptyState } from '../../components/ui/empty-state';
import { PageLoader, Spinner } from '../../components/ui/spinner';
import { useToast } from '../../components/ui/toast';
import { useSocket } from '../../lib/socket';
import { apiFetch, ApiError, downloadUrl } from '../../lib/api';
import { formatBytes, formatDate } from '../../lib/format';
import type { DocumentChunk, DocumentItem } from '../../lib/types';
import { useKbContext } from '../knowledge-bases/kb-context';
import { DocumentStatusBadge } from './StatusBadge';
import { UploadDropzone } from './UploadDropzone';
import { cn } from '../../lib/cn';

/** 前端提前拦一道 20MB：与后端 validateUpload 的默认上限一致，超限文件不必真的上传一遍 */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * 展开某份文档后的分段预览。
 *
 * 取数策略：
 * - 组件只在行展开时才挂载，所以查询是「点了才发」，不会为整张列表预取正文
 * - 独立的缓存键 ['document-chunks', orgId, documentId] 与端点 GET /documents/:documentId/chunks；
 *   文档重试/删除时父组件会 removeQueries 掉它，避免看到旧分段
 * - chunkCount 为 0 时不发请求（enabled），直接提示还在处理
 */
function DocumentChunks({
  orgId,
  document,
}: {
  orgId: string;
  document: DocumentItem;
}) {
  const query = useQuery({
    queryKey: ['document-chunks', orgId, document.id],
    queryFn: () =>
      apiFetch<DocumentChunk[]>(
        `/orgs/${orgId}/documents/${document.id}/chunks`,
      ),
    enabled: document.chunkCount > 0,
  });

  if (document.chunkCount === 0) {
    return (
      <p className="rounded-xl border border-line bg-white px-4 py-3 text-xs text-muted">
        文档尚未生成可展示的分段，请等待处理完成。
      </p>
    );
  }
  if (query.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-line bg-white px-4 py-3 text-xs text-muted">
        <Spinner className="h-4 w-4" />
        正在加载文档分段…
      </div>
    );
  }
  if (query.isError) {
    return (
      <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700">
        分段加载失败，请刷新后重试。
      </p>
    );
  }

  const chunks = query.data ?? [];
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-white">
      <div className="flex items-center justify-between border-b border-line bg-stone-50/70 px-4 py-3">
        <div>
          <p className="text-xs font-semibold text-ink">文档分段</p>
          <p className="mt-0.5 text-[11px] text-soft">
            每个分段的原文内容，按顺序排列
          </p>
        </div>
        <Badge tone="outline">{chunks.length} 段</Badge>
      </div>
      <div className="max-h-80 divide-y divide-line overflow-y-auto">
        {chunks.map((chunk) => (
          <div key={chunk.id} className="px-4 py-3.5">
            <Badge tone="indigo">片段 {chunk.chunkIndex + 1}</Badge>
            <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-muted">
              {chunk.content}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 按扩展名给文件图标底色：pdf 红、docx 蓝、md 绿，其余（txt 等）用默认靛蓝 */
function fileTint(filename: string) {
  const ext = filename.split('.').pop()?.toLowerCase();
  if (ext === 'pdf') return 'bg-red-50 text-red-600';
  if (ext === 'docx') return 'bg-sky-50 text-sky-600';
  if (ext === 'md') return 'bg-emerald-50 text-emerald-600';
  return 'bg-indigo-50 text-indigo-600';
}

/**
 * 文档页主体。
 * 步骤：
 * 1. 读当前知识库上下文与权限，拉文档列表
 * 2. 三个 mutation：上传（逐个文件）、失败重试、删除；各自在成功回调里失效对应缓存
 * 3. 断线兜底轮询：socket 未连接且列表里还有排队/处理中的文档时每 5 秒刷新列表
 * 4. 上传入口：canEdit 才显示投放区；查看者显示只读说明
 * 5. 列表渲染：表头与行共用同一套列模板；点击文件名展开分段；行内操作按权限和状态显隐
 */
export function DocumentsPage() {
  const { kb, orgId, kbId } = useKbContext();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { connected } = useSocket();
  const [uploadingName, setUploadingName] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DocumentItem | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // 查看者只读：effectivePermission 由后端按「组织角色 + 创建者 + 显式授权，accessMode='org' 兜底 viewer」现算，
  // 是界面唯一权限依据
  const canEdit = kb.effectivePermission !== 'viewer';

  const query = useQuery({
    queryKey: ['documents', orgId, kbId],
    queryFn: () =>
      apiFetch<DocumentItem[]>(`/orgs/${orgId}/knowledge-bases/${kbId}/documents`),
  });

  // 上传 mutation 不带 onSuccess：多文件是逐个 await 的，失效与提示统一放在 uploadFiles 的循环里，
  // 这样每个文件成功一次就刷新一次列表，而不是等整批结束
  const upload = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return apiFetch<DocumentItem>(
        `/orgs/${orgId}/knowledge-bases/${kbId}/documents`,
        { method: 'POST', body: form },
      );
    },
  });

  /**
   * 重试失败的文档：重新入队。
   * 成功回调做两件事——失效文档列表（状态会变回 queued）；移除该文档的分段缓存
   * （旧分段属于上一次处理结果，留着会与新一轮入库后的内容不一致）。
   */
  const retry = useMutation({
    mutationFn: (documentId: string) =>
      apiFetch(`/orgs/${orgId}/documents/${documentId}/retry`, { method: 'POST' }),
    onSuccess: (_data, documentId) => {
      queryClient.invalidateQueries({ queryKey: ['documents', orgId, kbId] });
      queryClient.removeQueries({
        queryKey: ['document-chunks', orgId, documentId],
      });
      toast({ title: '已重新加入处理队列', type: 'info' });
    },
  });

  /**
   * 删除文档。成功回调失效/清理四处：
   * 1. 文档列表
   * 2. 知识库列表（documentCount 计数变了）
   * 3. 该文档的分段缓存（直接移除，不再请求）
   * 4. 若正展开的是它，收起展开行
   */
  const remove = useMutation({
    mutationFn: (documentId: string) =>
      apiFetch(`/orgs/${orgId}/documents/${documentId}`, { method: 'DELETE' }),
    onSuccess: (_data, documentId) => {
      queryClient.invalidateQueries({ queryKey: ['documents', orgId, kbId] });
      queryClient.invalidateQueries({ queryKey: ['knowledge-bases', orgId] });
      queryClient.removeQueries({
        queryKey: ['document-chunks', orgId, documentId],
      });
      if (expandedId === documentId) setExpandedId(null);
      toast({ title: '文档已删除', type: 'success' });
      setDeleteTarget(null);
    },
  });

  const documents = query.data ?? [];

  // 断线兜底：只在 socket 未连接且存在 queued/processing 文档时轮询。
  // 连接正常时状态由 KbLayout 的 document:status 推送驱动，这里不重复请求
  useEffect(() => {
    if (connected) return;
    const hasPending = documents.some(
      (doc) => doc.status === 'queued' || doc.status === 'processing',
    );
    if (!hasPending) return;
    const timer = window.setInterval(() => {
      queryClient.invalidateQueries({ queryKey: ['documents', orgId, kbId] });
    }, 5000);
    return () => window.clearInterval(timer);
  }, [connected, documents, orgId, kbId, queryClient]);

  /**
   * 逐个上传选中的文件。步骤：
   * 1. 超过 20MB 的文件在前端直接跳过并记录错误文案（继续处理下一个）
   * 2. 每成功一个就失效文档列表并弹 toast，失败则记录该文件的错误信息后继续
   * 3. 全部结束后清空 uploadingName，恢复投放区
   * 串行 await 是刻意的：一次只展示一个文件名，也避免同时打满上传接口
   */
  const uploadFiles = async (files: File[]) => {
    setUploadError(null);
    for (const file of files) {
      if (file.size > MAX_UPLOAD_BYTES) {
        setUploadError(`${file.name} 超过 20MB 限制`);
        continue;
      }
      setUploadingName(file.name);
      try {
        await upload.mutateAsync(file);
        queryClient.invalidateQueries({ queryKey: ['documents', orgId, kbId] });
        toast({
          title: '文件已上传',
          description: `${file.name} 已加入处理队列`,
          type: 'success',
        });
      } catch (error) {
        setUploadError(
          error instanceof ApiError ? error.message : `${file.name} 上传失败`,
        );
      }
    }
    setUploadingName(null);
  };

  if (query.isLoading) return <PageLoader label="正在加载文档…" />;

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-ink">文档</h2>
          <p className="mt-1 text-sm text-muted">
            文档上传后会自动解析、切分并生成向量索引，状态会实时更新。
          </p>
        </div>
        <span className="text-xs text-soft">{documents.length} 份文档</span>
      </div>

      {canEdit ? (
        <UploadDropzone
          busy={Boolean(uploadingName)}
          uploadingName={uploadingName}
          onFiles={uploadFiles}
        />
      ) : (
        <div className="rounded-2xl border border-line bg-stone-50 px-5 py-4 text-sm text-muted">
          你当前是查看权限，可以下载文档但不能上传或删除。
        </div>
      )}

      {uploadError ? (
        <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3.5 py-3 text-sm text-red-700">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{uploadError}</span>
        </div>
      ) : null}

      {query.isError ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-red-700">
          文档列表加载失败，请刷新重试。
        </div>
      ) : documents.length ? (
        <div className="overflow-hidden rounded-2xl border border-line bg-white shadow-sm">
          {/*
           * 固定列宽模板 {文件, 状态, 片段, 上传时间, 操作} = 1fr + 110 + 90 + 160 + 100。
           * 表头与每一行必须共用同一列宽模板：表头用 grid-cols-[...] + lg:grid，行用 lg:grid-cols-[...]。
           * 末列曾用 auto，表头与行按各自内容算出的宽度不同，导致表头与数据列错位。改列宽时两处同步改。
           */}
          <div className="hidden grid-cols-[minmax(0,1fr)_110px_90px_160px_100px] items-center gap-4 border-b border-line bg-stone-50/70 px-5 py-3 text-[11px] font-semibold uppercase tracking-wide text-soft lg:grid">
            <span>文件</span>
            <span>状态</span>
            <span>片段</span>
            <span>上传时间</span>
            <span className="text-right">操作</span>
          </div>
          <div className="divide-y divide-line">
            {documents.map((doc) => {
              const expanded = expandedId === doc.id;
              return (
                <div key={doc.id}>
                  {/* 数据行：lg 断点启用的列模板与表头完全一致（见上），窄屏退化为纵向堆叠 */}
                  <div className="grid gap-3 px-5 py-4 transition hover:bg-stone-50/50 lg:grid-cols-[minmax(0,1fr)_110px_90px_160px_100px] lg:items-center lg:gap-4">
                    {/* 文件名整块是展开开关：同一时间只展开一行（expandedId 单值） */}
                    <button
                      type="button"
                      onClick={() => setExpandedId(expanded ? null : doc.id)}
                      aria-expanded={expanded}
                      className="flex min-w-0 items-center gap-3 rounded-lg text-left outline-none transition focus-visible:ring-2 focus-visible:ring-accent/30"
                    >
                      <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${fileTint(doc.filename)}`}>
                        <FileText className="h-4 w-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-ink">{doc.filename}</p>
                        <p className="mt-0.5 truncate text-[11px] text-soft">
                          {formatBytes(doc.sizeBytes)}
                          {doc.error ? ` · ${doc.error}` : ''}
                        </p>
                      </div>
                      <ChevronDown
                        className={cn(
                          'h-4 w-4 shrink-0 text-soft transition',
                          expanded && 'rotate-180',
                        )}
                      />
                    </button>

                    <div>
                      <DocumentStatusBadge status={doc.status} />
                    </div>
                    <div className="text-xs text-muted">{doc.chunkCount} 段</div>
                    <div className="whitespace-nowrap text-xs text-muted">
                      {formatDate(doc.createdAt)}
                    </div>

                    {/* 操作列：下载人人可用；重试仅失败态且可编辑；删除仅可编辑者 */}
                    <div className="flex items-center justify-end gap-1">
                      <a
                        href={downloadUrl(orgId, doc.id)}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded-lg p-2 text-muted transition hover:bg-stone-100 hover:text-ink"
                        aria-label={`下载 ${doc.filename}`}
                        title="下载原文件"
                      >
                        <Download className="h-4 w-4" />
                      </a>
                      {canEdit && doc.status === 'failed' ? (
                        <button
                          type="button"
                          onClick={() => retry.mutate(doc.id)}
                          disabled={retry.isPending}
                          className="rounded-lg p-2 text-muted transition hover:bg-stone-100 hover:text-ink disabled:opacity-50"
                          aria-label={`重试 ${doc.filename}`}
                          title="重新处理"
                        >
                          <RotateCcw className="h-4 w-4" />
                        </button>
                      ) : null}
                      {canEdit ? (
                        <button
                          type="button"
                          onClick={() => setDeleteTarget(doc)}
                          className="rounded-lg p-2 text-muted transition hover:bg-red-50 hover:text-red-600"
                          aria-label={`删除 ${doc.filename}`}
                          title="删除文档"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      ) : null}
                    </div>
                  </div>

                  {/* 只有展开行才挂载分段组件，因此分段请求是「点击后才发」 */}
                  {expanded ? (
                    <div className="border-t border-line bg-stone-50/50 px-5 py-4">
                      <DocumentChunks orgId={orgId} document={doc} />
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <EmptyState
          icon={FileText}
          title="还没有文档"
          description={
            canEdit
              ? '上传 TXT、MD、PDF 或 DOCX 文件，几秒后就能开始提问。'
              : '该知识库还没有可供检索的文档。'
          }
        />
      )}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) remove.mutate(deleteTarget.id);
        }}
        title="删除文档"
        description={`确定删除「${deleteTarget?.filename ?? ''}」吗？对应的向量片段会一并删除。`}
        busy={remove.isPending}
      />

      {retry.error instanceof ApiError ? (
        <p className="text-xs text-red-600">{retry.error.message}</p>
      ) : null}
    </div>
  );
}
