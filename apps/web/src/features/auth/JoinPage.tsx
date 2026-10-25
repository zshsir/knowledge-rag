/**
 * 邀请接受页（/join/:token）：把一次性的邀请链接变成一个组织成员身份。
 *
 * 职责与边界：
 * - 只做「已登录的人点接受」这一条路径；未登录时给两个出口——去 /login（next 指回本页）或
 *   去 /register?invite=<token>（那条路径由后端 auth.service 的注册分支直接消费邀请）
 * - 展示邀请详情（GET /invites/:token），valid=false 表示已用过或过期，此时不显示接受按钮
 * - 接受只发 POST /invites/:token/accept，成功后必须先 refreshMe() 再跳组织页：
 *   跳转目标依赖响应里的 organization.id，而侧栏/路由读的是 useAuth 的 organizations——
 *   不先刷新，落地页就找不到这个组织
 * - 不做任何权限判断，接受者能不能加入完全由后端在 accept 时校验
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AlertCircle, ArrowRight, Building2, UserPlus } from 'lucide-react';
import { Button, buttonClasses } from '../../components/ui/button';
import { Spinner } from '../../components/ui/spinner';
import { apiFetch, ApiError } from '../../lib/api';
import type { InviteInfo, Organization } from '../../lib/types';
import { AuthLayout } from './AuthLayout';
import { useAuth } from './AuthProvider';

/**
 * 邀请落地页。
 * 步骤：
 * 1. 用路径里的 token 查邀请详情，同时拿到当前登录态（isLoading 时先渲染整页 Spinner，
 *    避免「未登录」分支在会话未就绪时抢先闪出登录按钮）
 * 2. 接受：POST /invites/:token/accept → await refreshMe() 让 organizations 带上新组织 →
 *    replace 跳 /orgs/:id，使邀请页不留在历史栈
 * 3. 渲染分支优先级：邀请详情加载中 → 详情/接受报错 → valid=false（用过或过期）→
 *    已登录（接受按钮）→ 未登录（登录 / 注册两条链接）
 */
export function JoinPage() {
  const { token = '' } = useParams();
  const { user, isLoading, refreshMe } = useAuth();
  const navigate = useNavigate();

  const inviteInfo = useQuery({
    queryKey: ['invite-info', token],
    queryFn: () => apiFetch<InviteInfo>(`/invites/${token}`),
    retry: false,
  });

  const accept = useMutation({
    mutationFn: () =>
      apiFetch<{ organization: Organization }>(`/invites/${token}/accept`, {
        method: 'POST',
      }),
    onSuccess: async (data) => {
      // refreshMe 必须 await：组织页与侧栏都从 AuthProvider 的 organizations 里找 orgId
      await refreshMe();
      navigate(`/orgs/${data.organization.id}`, { replace: true });
    },
  });

  // 步骤 1：会话未就绪时整页等待，避免未登录分支误闪
  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  const info = inviteInfo.data;
  // 步骤 3：详情查询与接受请求共用同一个错误位置，用户只需要看一处红字
  const error = inviteInfo.error ?? accept.error;

  return (
    <AuthLayout
      eyebrow="Workspace invitation"
      title="加入团队知识库"
      description="接受邀请后，你将可以访问组织内的知识库与对话。"
      footer={
        <Link to="/" className="font-medium text-accent hover:text-accent-dark">
          返回工作区
        </Link>
      }
    >
      <div className="rounded-xl border border-line bg-stone-50/70 p-5">
        {inviteInfo.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted">
            <Spinner className="h-4 w-4" /> 正在验证邀请链接…
          </div>
        ) : error ? (
          <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3.5 py-3 text-sm text-red-700">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error instanceof ApiError ? error.message : '邀请链接无效或已失效'}</span>
          </div>
        ) : info ? (
          <>
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent-soft text-accent">
                <Building2 className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm font-semibold text-ink">{info.orgName}</p>
                <p className="mt-0.5 text-xs text-muted">
                  邀请角色：{info.role === 'admin' ? '管理员' : '成员'}
                </p>
              </div>
            </div>

            <div className="mt-6 space-y-3">
              {!info.valid ? (
                <p className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3 text-sm text-amber-800">
                  该邀请已使用或已过期，请联系组织管理员重新生成。
                </p>
              ) : user ? (
                <Button
                  className="w-full"
                  onClick={() => accept.mutate()}
                  loading={accept.isPending}
                >
                  <UserPlus className="h-4 w-4" />
                  接受邀请并加入
                </Button>
              ) : (
                <>
                  <Link
                    to={`/login?next=${encodeURIComponent(`/join/${token}`)}`}
                    className={buttonClasses('primary', 'lg', 'w-full')}
                  >
                    登录后加入
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                  <Link
                    to={`/register?invite=${encodeURIComponent(token)}`}
                    className={buttonClasses('secondary', 'lg', 'w-full')}
                  >
                    创建账号并加入
                  </Link>
                </>
              )}
            </div>
          </>
        ) : null}
      </div>
    </AuthLayout>
  );
}
