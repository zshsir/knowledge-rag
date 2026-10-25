/**
 * 单个知识库的布局壳（/orgs/:orgId/kbs/:kbId）：取库信息 → 进实时房间 → 渲染页头与 tab →
 * 把 { kb, orgId, kbId } 通过 <Outlet context> 交给子路由（对话 / 文档 / 成员）。
 *
 * 职责与边界：
 * - 只负责「这一层」：库标题、访问范围徽标、我的有效权限、三个 tab、设置弹窗入口，以及实时事件的接线；
 *   具体页面内容全部在子路由里
 * - 不自己判权限：kb.effectivePermission 由后端 resolve（组织角色 + 创建者 + 显式授权三者，
 *   都没命中且 accessMode='org' 时再兜底 viewer），
 *   前端只按它决定「成员 tab / 设置按钮是否出现」，真正的拦截在服务端
 * - 删除权限 canDelete 是「创建者或组织 owner/admin」的客户端预判，仅用于是否显示危险区；
 *   后端另有一道判定，不能把这里当成安全边界
 * - 成员 tab 与设置按钮只对 manager 渲染，这只是体验层隐藏：成员列表/改权限/改设置的数据接口
 *   各自有 manager 门槛（KbPermissionGuard + @RequireKbPermission('manager')），绕过 UI 直接请求仍会被拒
 */
import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BookOpen,
  FileText,
  Globe2,
  Lock,
  MessageSquare,
  Settings2,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { PageLoader } from '../../components/ui/spinner';
import { useToast } from '../../components/ui/toast';
import { useSocket } from '../../lib/socket';
import { apiFetch } from '../../lib/api';
import type {
  AccessRevokedEvent,
  DocumentStatusEvent,
  KnowledgeBase,
} from '../../lib/types';
import { useAuth } from '../auth/AuthProvider';
import { KbSettingsDialog } from './KbSettingsDialog';
import type { KbOutletContext } from './kb-context';
import { cn } from '../../lib/cn';

const permissionLabels = {
  viewer: '可查看',
  editor: '可编辑',
  manager: '可管理',
};

const tabClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    'inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition',
    isActive
      ? 'bg-white text-ink shadow-sm ring-1 ring-line'
      : 'text-muted hover:bg-white/70 hover:text-ink',
  );

/**
 * 知识库布局。
 * 步骤：
 * 1. 用 ['kb', orgId, kbId] 拉库详情；retry:false，加载中转圈、失败（含 403/404）整块换成「无法访问」
 * 2. 实时接线（effect，仅在 socket 就绪且已连接时执行）：
 *    2a. emitWithAck('kb:join') 带 5s 超时进房间；ack.ok=false 说明 HTTP 过了但实时层复判失败
 *        （例如权限刚被撤），用 joinDenied 换成整页提示
 *    2b. 监听 document:status：只认本 kbId，失效文档与库列表缓存；ready/failed 弹对应 toast，
 *        让「上传后一直转圈」有明确的结束信号
 *    2c. 监听 kb:access-revoked：弹错误 toast、失效列表并退回组织首页——不必等用户手动刷新
 *    2d. 清理：置 active=false 防卸载后再 setState，发 kb:leave 并 off 两个处理器；重连时 effect 会重跑
 * 3. 三个早退分支按顺序：加载中 → 详情失败 → joinDenied
 * 4. 正常渲染页头、tab 与 Outlet；子页通过 useKbContext 拿到同一份 kb，避免各自重复请求
 */
export function KbLayout() {
  const { orgId = '', kbId = '' } = useParams();
  const { organizations, user } = useAuth();
  const { socket, connected } = useSocket();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [joinDenied, setJoinDenied] = useState(false);

  const org = organizations.find((item) => item.id === orgId);
  const query = useQuery({
    queryKey: ['kb', orgId, kbId],
    queryFn: () => apiFetch<KnowledgeBase>(`/orgs/${orgId}/knowledge-bases/${kbId}`),
    retry: false,
  });

  useEffect(() => {
    // 步骤 2：socket 未建好或正断线时什么都不做，等 connected 变 true 后本 effect 自动重跑
    if (!socket || !connected) return;
    let active = true;

    // 步骤 2a：进房间。超时/失败只说明实时通道不可用，不影响 HTTP 数据，因此只轻提示
    socket
      .timeout(5000)
      .emitWithAck('kb:join', { orgId, kbId })
      .then((ack: { ok: boolean; permission?: string }) => {
        if (!active) return;
        if (!ack?.ok) setJoinDenied(true);
      })
      .catch(() => {
        if (active) {
          toast({
            title: '实时连接暂时不可用',
            description: '文档状态可能延迟更新，刷新页面可重试。',
            type: 'info',
          });
        }
      });

    // 步骤 2b：文档处理结果。房间是按库订阅的，但同一连接可能收到别处的广播，所以先比 kbId
    const onDocumentStatus = (event: DocumentStatusEvent) => {
      if (event.kbId !== kbId) return;
      queryClient.invalidateQueries({ queryKey: ['documents', orgId, kbId] });
      queryClient.invalidateQueries({ queryKey: ['knowledge-bases', orgId] });
      if (event.status === 'ready') {
        toast({
          title: '文档已就绪',
          description: `已生成 ${event.chunkCount} 个文本片段`,
          type: 'success',
        });
      }
      if (event.status === 'failed') {
        toast({
          title: '文档处理失败',
          description: event.error ?? '请查看文档列表中的错误信息',
          type: 'error',
        });
      }
    };

    // 步骤 2c：被撤权。后端已把人移出房间，这里只负责告知 + 导航，不在这里清 kb 缓存（下次进入会重新拉）
    const onAccessRevoked = (event: AccessRevokedEvent) => {
      if (event.kbId !== kbId) return;
      toast({
        title: '访问权限已变更',
        description: '你已不再拥有该知识库的访问权限。',
        type: 'error',
      });
      queryClient.invalidateQueries({ queryKey: ['knowledge-bases', orgId] });
      navigate(`/orgs/${orgId}`, { replace: true });
    };

    socket.on('document:status', onDocumentStatus);
    socket.on('kb:access-revoked', onAccessRevoked);

    return () => {
      active = false;
      socket.emit('kb:leave', { kbId });
      socket.off('document:status', onDocumentStatus);
      socket.off('kb:access-revoked', onAccessRevoked);
    };
  }, [socket, connected, orgId, kbId, queryClient, navigate, toast]);

  if (query.isLoading) return <PageLoader label="正在打开知识库…" />;

  if (query.isError || !query.data) {
    return (
      <div className="mx-auto max-w-lg rounded-2xl border border-line bg-white p-8 text-center shadow-sm">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-red-50 text-red-600">
          <Lock className="h-6 w-6" />
        </div>
        <h1 className="mt-4 text-lg font-semibold text-ink">无法访问知识库</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          知识库可能已被删除，或你的访问权限已被变更。
        </p>
        <Link to={`/orgs/${orgId}`} className="mt-5 inline-block text-sm font-medium text-accent">
          返回组织首页
        </Link>
      </div>
    );
  }

  if (joinDenied) {
    return (
      <div className="mx-auto max-w-lg rounded-2xl border border-line bg-white p-8 text-center shadow-sm">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-50 text-amber-600">
          <ShieldCheck className="h-6 w-6" />
        </div>
        <h1 className="mt-4 text-lg font-semibold text-ink">实时权限校验未通过</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          你的知识库访问权限可能刚刚发生变化，请刷新或返回组织首页。
        </p>
        <Button className="mt-5" onClick={() => navigate(`/orgs/${orgId}`)}>
          返回组织首页
        </Button>
      </div>
    );
  }

  const kb = query.data;
  const isManager = kb.effectivePermission === 'manager';
  const canDelete = Boolean(
    user &&
      (kb.createdBy === user.id || org?.role === 'owner' || org?.role === 'admin'),
  );
  const context: KbOutletContext = { kb, orgId, kbId };

  // 步骤 4：Outlet 上挂 context，子页用 useKbContext() 读同一份 kb / orgId / kbId
  return (
    <div className="animate-fade-in">
      <header className="border-b border-line pb-4">
        <div className="flex items-center gap-1.5 text-xs text-soft">
          <Link to={`/orgs/${orgId}`} className="transition hover:text-ink">
            {org?.name ?? '组织'}
          </Link>
          <span>/</span>
          <span>知识库</span>
        </div>

        <div className="mt-3 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-3.5">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-indigo-700 text-white shadow-lg shadow-indigo-900/20">
              <BookOpen className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-xl font-semibold tracking-tight text-ink sm:text-2xl">
                {kb.name}
              </h1>
              <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted">
                {kb.description || '暂无描述'}
              </p>
              <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                <Badge tone={kb.accessMode === 'restricted' ? 'warning' : 'neutral'}>
                  {kb.accessMode === 'restricted' ? (
                    <Lock className="h-3 w-3" />
                  ) : (
                    <Globe2 className="h-3 w-3" />
                  )}
                  {kb.accessMode === 'restricted' ? '指定成员' : '组织公开'}
                </Badge>
                <Badge tone="indigo">{permissionLabels[kb.effectivePermission]}</Badge>
              </div>
            </div>
          </div>
          {isManager ? (
            <Button variant="secondary" onClick={() => setSettingsOpen(true)}>
              <Settings2 className="h-4 w-4" />
              设置
            </Button>
          ) : null}
        </div>

        <nav className="mt-5 flex items-center gap-1 rounded-xl border border-line bg-stone-100/70 p-1">
          <NavLink to="chat" className={tabClass}>
            <MessageSquare className="h-4 w-4" />
            对话
          </NavLink>
          <NavLink to="documents" className={tabClass}>
            <FileText className="h-4 w-4" />
            文档
          </NavLink>
          {isManager ? (
            <NavLink to="members" className={tabClass}>
              <Users className="h-4 w-4" />
              成员
            </NavLink>
          ) : null}
        </nav>
      </header>

      <div className="pt-5">
        <Outlet context={context} />
      </div>

      <KbSettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        kb={kb}
        orgId={orgId}
        canDelete={canDelete}
        onDeleted={() => navigate(`/orgs/${orgId}`, { replace: true })}
      />
    </div>
  );
}
