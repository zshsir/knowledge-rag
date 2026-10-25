/**
 * 组织首页 / 知识库总览（/orgs/:orgId）：统计条 + 知识库卡片网格 + 空态 + 新建入口。
 *
 * 职责与边界：
 * - 只读 ['knowledge-bases', orgId] 这一条列表数据：kbs 数量、文档总量都由它就地算出（文档总数是
 *   各库 documentCount 的求和，不额外请求）
 * - 卡片展示的是「当前用户可见的库」：后端已按有效权限过滤，所以这里不需要再判角色
 * - 边界：不做成员管理、组织设置、删除库；这些分别在成员页与 KbLayout 的设置弹窗里
 * - 注意：页面内的新建对话框与 AppShell 的全局「新建知识库」入口各挂一个实例，同页共存；
 *   这正是 CreateKbDialog 必须用 useId 生成表单 id 的原因（详见该文件头）
 */
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowUpRight,
  BookOpen,
  FileText,
  Globe2,
  Lock,
  Plus,
  Sparkles,
  Users,
} from 'lucide-react';
import { Button, buttonClasses } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { EmptyState } from '../../components/ui/empty-state';
import { PageLoader } from '../../components/ui/spinner';
import { Skeleton } from '../../components/ui/skeleton';
import { useAuth } from '../auth/AuthProvider';
import { apiFetch } from '../../lib/api';
import type { KnowledgeBase } from '../../lib/types';
import { CreateKbDialog } from './CreateKbDialog';

const permissionLabel = {
  viewer: '可查看',
  editor: '可编辑',
  manager: '可管理',
};

/**
 * 单张知识库卡片：整卡是一个链接，统一进该库的「对话」tab。
 * 展示名称、两行截断的描述、访问范围徽标、我的有效权限，以及文档数/成员数。
 * 两个计数在类型上是可选字段，所以用 ?? 0 兜底——当前后端列表接口总会带回它们，这只是防御。
 */
function KbCard({ kb, orgId }: { kb: KnowledgeBase; orgId: string }) {
  return (
    <Link
      to={`/orgs/${orgId}/kbs/${kb.id}/chat`}
      className="group relative flex flex-col rounded-2xl border border-line bg-white p-5 shadow-sm outline-none transition duration-200 hover:-translate-y-0.5 hover:border-indigo-200 hover:shadow-lg hover:shadow-indigo-950/[0.06] focus-visible:ring-2 focus-visible:ring-accent/40"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-50 to-stone-50 text-accent ring-1 ring-indigo-100">
          <BookOpen className="h-5 w-5" />
        </div>
        <ArrowUpRight className="h-4 w-4 text-soft opacity-0 transition group-hover:opacity-100" />
      </div>
      <h3 className="mt-4 truncate text-sm font-semibold tracking-tight text-ink">{kb.name}</h3>
      <p className="mt-1.5 line-clamp-2 min-h-10 text-xs leading-relaxed text-muted">
        {kb.description || '暂无描述'}
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-1.5">
        <Badge tone={kb.accessMode === 'restricted' ? 'warning' : 'neutral'}>
          {kb.accessMode === 'restricted' ? (
            <Lock className="h-3 w-3" />
          ) : (
            <Globe2 className="h-3 w-3" />
          )}
          {kb.accessMode === 'restricted' ? '指定成员' : '组织公开'}
        </Badge>
        <Badge tone="outline">{permissionLabel[kb.effectivePermission]}</Badge>
      </div>
      <div className="mt-4 flex items-center gap-4 border-t border-line/70 pt-3 text-[11px] text-soft">
        <span className="inline-flex items-center gap-1.5">
          <FileText className="h-3.5 w-3.5" />
          {kb.documentCount ?? 0} 份文档
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Users className="h-3.5 w-3.5" />
          {kb.memberCount ?? 0} 位成员
        </span>
      </div>
    </Link>
  );
}

/**
 * 组织首页。
 * 步骤：
 * 1. 从 useAuth 的 organizations 里取当前组织（拿角色文案），并拉知识库列表
 * 2. 顶部统计：库数量直接取数组长度，文档总量用 reduce 汇总各库 documentCount
 * 3. 三种数据态 + 空态：加载中显示三张骨架卡 → 失败显示可重试文案 → 有数据渲染 KbCard 网格；
 *    空数组则显示引导创建的 EmptyState
 * 4. 新建成功后由 onCreated 直接跳到新库的文档页（刚建库时上传资料是下一步动作）
 */
export function OrgHomePage() {
  const { orgId = '' } = useParams();
  const { organizations } = useAuth();
  const org = organizations.find((item) => item.id === orgId);
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);

  const query = useQuery({
    queryKey: ['knowledge-bases', orgId],
    queryFn: () => apiFetch<KnowledgeBase[]>(`/orgs/${orgId}/knowledge-bases`),
  });

  const kbs = query.data ?? [];
  const documentCount = kbs.reduce((sum, kb) => sum + (kb.documentCount ?? 0), 0);

  return (
    <div className="animate-fade-in">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-xs font-medium text-soft">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            工作区 · {org?.role === 'owner' ? '所有者' : org?.role === 'admin' ? '管理员' : '成员'}
          </div>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink sm:text-[28px]">
            {org?.name ?? '知识库总览'}
          </h1>
          <p className="mt-1.5 text-sm text-muted">
            选择一个知识库开始对话，或为团队创建新的资料空间。
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          新建知识库
        </Button>
      </div>

      <div className="mt-7 grid gap-3 sm:grid-cols-3">
        <div className="rounded-2xl border border-line bg-white p-4">
          <p className="text-xs font-medium text-soft">知识库</p>
          <p className="mt-2 text-2xl font-semibold tracking-tight text-ink">{kbs.length}</p>
          <p className="mt-1 text-xs text-muted">你可访问的资料空间</p>
        </div>
        <div className="rounded-2xl border border-line bg-white p-4">
          <p className="text-xs font-medium text-soft">文档总量</p>
          <p className="mt-2 text-2xl font-semibold tracking-tight text-ink">{documentCount}</p>
          <p className="mt-1 text-xs text-muted">已上传并建立索引</p>
        </div>
        <div className="relative overflow-hidden rounded-2xl border border-indigo-100 bg-gradient-to-br from-indigo-50 via-white to-stone-50 p-4">
          <Sparkles className="absolute right-4 top-4 h-4 w-4 text-accent/60" />
          <p className="text-xs font-medium text-accent">小提示</p>
          <p className="mt-2 text-sm font-medium leading-relaxed text-ink">
            先上传资料，再提问，回答会带上可核验的引用。
          </p>
        </div>
      </div>

      <div className="mt-8 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">全部知识库</h2>
        <span className="text-xs text-soft">{kbs.length} 个</span>
      </div>

      <div className="mt-4">
        {query.isLoading ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {[1, 2, 3].map((item) => (
              <Skeleton key={item} className="h-56 rounded-2xl" />
            ))}
          </div>
        ) : query.isError ? (
          <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-sm text-red-700">
            加载知识库失败，请刷新页面重试。
          </div>
        ) : kbs.length ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {kbs.map((kb) => (
              <KbCard key={kb.id} kb={kb} orgId={orgId} />
            ))}
          </div>
        ) : (
          <EmptyState
            icon={BookOpen}
            title="还没有知识库"
            description="创建第一个知识库，把团队文档变成可以随时提问的答案。"
            action={
              <button
                type="button"
                onClick={() => setCreateOpen(true)}
                className={buttonClasses('primary')}
              >
                <Plus className="h-4 w-4" />
                创建知识库
              </button>
            }
          />
        )}
      </div>

      <CreateKbDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        orgId={orgId}
        onCreated={(kb) => navigate(`/orgs/${orgId}/kbs/${kb.id}/documents`)}
      />
    </div>
  );
}
