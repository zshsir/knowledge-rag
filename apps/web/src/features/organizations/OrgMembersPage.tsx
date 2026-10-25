/**
 * 组织成员与权限页：成员列表、角色调整、移除成员、邀请链接的生成/查看/撤销。
 *
 * 权限口径（界面与后端一致，后端才是执法点）：
 * - 成员列表：本组织任何成员都能看（后端 list 不设角色门槛）
 * - 邀请相关（列表/生成/撤销）：仅 owner 与 admin；成员连列表都不请求（见 invitesQuery 的 enabled）
 * - 改角色：仅 owner，且改不动 owner 那一行；可改成 admin 或 member
 * - 移除：owner 可移 admin/member；admin 只能移 member（同级 admin 互斥）；都不能移自己或 owner
 * 边界：知识库级授权不在这里（在对应知识库的成员页）；本页不处理接受邀请（JoinPage 负责）。
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Copy,
  Link2,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
} from 'lucide-react';
import { useParams } from 'react-router-dom';
import { Avatar } from '../../components/ui/avatar';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { ConfirmDialog } from '../../components/ui/confirm-dialog';
import { Dialog } from '../../components/ui/dialog';
import { EmptyState } from '../../components/ui/empty-state';
import { Field } from '../../components/ui/input';
import { Select } from '../../components/ui/select';
import { PageLoader } from '../../components/ui/spinner';
import { useToast } from '../../components/ui/toast';
import { apiFetch, ApiError } from '../../lib/api';
import { copyText } from '../../lib/clipboard';
import { formatDate, timeAgo } from '../../lib/format';
import type { CreatedInvite, Invite, OrgMember, OrgRole } from '../../lib/types';
import { useAuth } from '../auth/AuthProvider';

const roleLabels: Record<OrgRole, string> = {
  owner: '所有者',
  admin: '管理员',
  member: '成员',
};

// 角色徽标配色：owner 靛蓝、admin 绿、member 中性
const roleTones: Record<OrgRole, 'indigo' | 'success' | 'neutral'> = {
  owner: 'indigo',
  admin: 'success',
  member: 'neutral',
};

/**
 * 邀请的展示状态：纯前端按字段推导，不额外请求。
 * 顺序有意义——已接受优先于已过期（接受后即使过了有效期也显示「已加入」）。
 * 过期判断用的是浏览器本地时钟与后端返回的 expiresAt 比较；没有续期概念，签发即定死 7 天。
 */
function inviteStatus(invite: Invite): {
  label: string;
  tone: 'success' | 'warning' | 'neutral' | 'danger';
} {
  if (invite.acceptedAt) return { label: '已加入', tone: 'success' };
  if (new Date(invite.expiresAt).getTime() <= Date.now()) {
    return { label: '已过期', tone: 'neutral' };
  }
  return { label: '待接受', tone: 'warning' };
}

/**
 * 组织成员页主体。
 * 步骤：
 * 1. 从 useAuth 的组织列表里取当前 org（决定「我」的角色），拉成员列表
 * 2. owner/admin 才拉邀请列表（enabled: canManage）——普通成员请求会被后端 403
 * 3. 四个 mutation：签发邀请、改角色、移除成员、撤销邀请；成功后各自失效对应缓存
 * 4. 渲染：成员行按 canRemove/是否 owner 决定角色下拉与移除按钮；邀请区块仅管理者可见
 * 5. 邀请弹窗：生成前选角色，生成后只展示这一次返回的链接（令牌不会再次下发）
 */
export function OrgMembersPage() {
  const { orgId = '' } = useParams();
  const { organizations, user } = useAuth();
  const org = organizations.find((item) => item.id === orgId);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteRole, setInviteRole] = useState<'admin' | 'member'>('member');
  const [createdInvite, setCreatedInvite] = useState<CreatedInvite | null>(null);
  const [removeTarget, setRemoveTarget] = useState<OrgMember | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<Invite | null>(null);

  // 管理资格：owner 与 admin；改角色还要再收紧到 isOwner（见下方 select 的渲染条件与后端规则）
  const canManage = org?.role === 'owner' || org?.role === 'admin';
  const isOwner = org?.role === 'owner';

  const membersQuery = useQuery({
    queryKey: ['org-members', orgId],
    queryFn: () => apiFetch<OrgMember[]>(`/orgs/${orgId}/members`),
  });

  // 邀请列表只对 owner/admin 取：普通成员没有查看权限，enabled 为 false 时不发请求也不报错
  const invitesQuery = useQuery({
    queryKey: ['org-invites', orgId],
    queryFn: () => apiFetch<Invite[]>(`/orgs/${orgId}/invites`),
    enabled: canManage,
  });

  /**
   * 生成邀请链接：POST /orgs/:orgId/invites，body 只有 role。
   * 成功回调把返回的 CreatedInvite（含原始 token 拼出的 url）留在本地 state：
   * 服务端只在签发这一刻返回原文，之后列表接口拿不到，所以弹窗必须当场展示并复制。
   */
  const createInvite = useMutation({
    mutationFn: () =>
      apiFetch<CreatedInvite>(`/orgs/${orgId}/invites`, {
        method: 'POST',
        body: JSON.stringify({ role: inviteRole }),
      }),
    onSuccess: (invite) => {
      setCreatedInvite(invite);
      queryClient.invalidateQueries({ queryKey: ['org-invites', orgId] });
      toast({ title: '邀请链接已生成', type: 'success' });
    },
  });

  /** 改角色：PATCH /members/:userId；后端只允许 owner 操作，且目标不能是 owner */
  const updateRole = useMutation({
    mutationFn: (input: { userId: string; role: 'admin' | 'member' }) =>
      apiFetch(`/orgs/${orgId}/members/${input.userId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role: input.role }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['org-members', orgId] });
      toast({ title: '成员角色已更新', type: 'success' });
    },
  });

  /**
   * 移除成员：后端在一个事务里连带删除该用户在本组织的知识库授权与全部会话，
   * 再通过实时事件把人踢出知识库房间；前端只需失效成员列表。
   */
  const removeMember = useMutation({
    mutationFn: (userId: string) =>
      apiFetch(`/orgs/${orgId}/members/${userId}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['org-members', orgId] });
      setRemoveTarget(null);
      toast({ title: '成员已移除', type: 'success' });
    },
  });

  /**
   * 撤销邀请：删除后端那一行，链接随即失效。
   * 按钮对每一行都显示（含「已加入」），但撤销只删邀请记录，不会移除已加入的成员
   */
  const revokeInvite = useMutation({
    mutationFn: (inviteId: string) =>
      apiFetch(`/orgs/${orgId}/invites/${inviteId}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['org-invites', orgId] });
      setRevokeTarget(null);
      toast({ title: '邀请已撤销', type: 'success' });
    },
  });

  if (membersQuery.isLoading) return <PageLoader label="正在加载成员…" />;

  const members = membersQuery.data ?? [];
  const invites = invitesQuery.data ?? [];
  const error =
    createInvite.error ?? updateRole.error ?? removeMember.error ?? revokeInvite.error;

  const copyInvite = async () => {
    if (!createdInvite) return;
    try {
      await copyText(createdInvite.url);
      toast({ title: '邀请链接已复制', type: 'success' });
    } catch {
      toast({ title: '复制失败，请手动选择链接', type: 'error' });
    }
  };

  /**
   * 能否移除某个成员（与 MembersService.remove 的四道校验一一对应）：
   * 1. 非管理员不可移除；也不能移除自己（后端 400）
   * 2. owner 永远不可移除（后端 403）
   * 3. admin 不能移除同级 admin（后端 403）；owner 可以
   * 注意：这里只决定按钮显隐，最终裁决仍在后端
   */
  const canRemove = (member: OrgMember) => {
    if (!canManage || member.id === user?.id) return false;
    if (member.role === 'owner') return false;
    if (!isOwner && member.role === 'admin') return false;
    return true;
  };

  return (
    <div className="animate-fade-in space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">成员与权限</h1>
          <p className="mt-1.5 text-sm text-muted">
            管理组织成员、邀请链接和角色。知识库级授权请在对应知识库内配置。
          </p>
        </div>
        {canManage ? (
          <Button
            onClick={() => {
              setCreatedInvite(null);
              setInviteRole('member');
              setInviteOpen(true);
            }}
          >
            <UserPlus className="h-4 w-4" />
            邀请成员
          </Button>
        ) : null}
      </div>

      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-3 text-sm text-red-700">
          {error instanceof ApiError ? error.message : '操作失败，请稍后重试'}
        </div>
      ) : null}

      <div className="rounded-2xl border border-line bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-accent" />
            <h2 className="text-sm font-semibold text-ink">组织成员</h2>
            <Badge tone="outline">{members.length}</Badge>
          </div>
          <span className="text-[11px] text-soft">
            当前身份：{org ? roleLabels[org.role] : '—'}
          </span>
        </div>

        <div className="divide-y divide-line">
          {members.map((member) => (
            <div
              key={member.id}
              className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center"
            >
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <Avatar name={member.name} size="md" />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium text-ink">{member.name}</p>
                    {member.id === user?.id ? (
                      <span className="text-[10px] text-soft">你</span>
                    ) : null}
                  </div>
                  <p className="truncate text-xs text-soft">{member.email}</p>
                </div>
              </div>

              <div className="flex items-center gap-2 sm:justify-end">
                {/*
                 * 角色下拉只有 owner 能看到（且目标不能是 owner）；其他情况一律显示只读徽标。
                 * admin 在界面上没有改角色的入口，后端 updateRole 对非 owner 也一律 403；
                 * 而 remove 允许 admin 移除普通成员——两条接口的门槛并不相同
                 */}
                {isOwner && member.role !== 'owner' ? (
                  <select
                    value={member.role}
                    disabled={updateRole.isPending}
                    onChange={(event) =>
                      updateRole.mutate({
                        userId: member.id,
                        role: event.target.value as 'admin' | 'member',
                      })
                    }
                    className="h-9 rounded-lg border border-line bg-white px-2 text-xs text-ink outline-none focus:border-accent/60"
                    aria-label={`修改 ${member.name} 的角色`}
                  >
                    <option value="member">成员</option>
                    <option value="admin">管理员</option>
                  </select>
                ) : (
                  <Badge tone={roleTones[member.role]}>{roleLabels[member.role]}</Badge>
                )}

                {canRemove(member) ? (
                  <button
                    type="button"
                    onClick={() => setRemoveTarget(member)}
                    className="rounded-lg p-2 text-muted transition hover:bg-red-50 hover:text-red-600"
                    aria-label={`移除 ${member.name}`}
                    title="移除成员"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </div>

      {canManage ? (
        <div className="rounded-2xl border border-line bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-line px-5 py-4">
            <div className="flex items-center gap-2">
              <Link2 className="h-4 w-4 text-accent" />
              <h2 className="text-sm font-semibold text-ink">邀请链接</h2>
            </div>
            {/* 有效期由后端签发时写死为 7 天（INVITE_TTL_DAYS），没有续期入口 */}
            <span className="text-[11px] text-soft">一次性 · 7 天有效</span>
          </div>

          {invites.length ? (
            <div className="divide-y divide-line">
              {invites.map((invite) => {
                const status = inviteStatus(invite);
                return (
                  <div
                    key={invite.id}
                    className="flex flex-col gap-2 px-5 py-3.5 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-stone-100 text-muted">
                        <Link2 className="h-4 w-4" />
                      </div>
                      <div>
                        <p className="text-sm text-ink">
                          {invite.role === 'admin' ? '管理员邀请' : '成员邀请'}
                        </p>
                        <p className="mt-0.5 text-[11px] text-soft">
                          创建于 {timeAgo(invite.createdAt)} · 到期 {formatDate(invite.expiresAt)}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 sm:justify-end">
                      <Badge tone={status.tone}>{status.label}</Badge>
                      <button
                        type="button"
                        onClick={() => setRevokeTarget(invite)}
                        className="rounded-lg p-2 text-muted transition hover:bg-red-50 hover:text-red-600"
                        aria-label="撤销邀请"
                        title="撤销邀请"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="px-5 py-8 text-center text-xs text-soft">
              还没有邀请。生成一个链接，分享给团队成员即可加入。
            </div>
          )}
        </div>
      ) : null}

      <div className="rounded-2xl border border-line bg-stone-50/60 p-4 text-xs leading-relaxed text-muted">
        <div className="flex items-start gap-2">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
          <p>
            所有者可管理组织名称、成员角色和邀请；管理员可邀请普通成员并移除普通成员；
            成员的可见知识库范围由其知识库授权决定。
          </p>
        </div>
      </div>

      <Dialog
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        title="邀请成员"
        description="生成一次性邀请链接，链接 7 天内有效。"
        footer={
          // 生成成功后页脚只剩「完成」；链接已一次性下发，关闭即无法再次查看
          createdInvite ? (
            <Button onClick={() => setInviteOpen(false)}>完成</Button>
          ) : (
            <>
              <Button variant="secondary" onClick={() => setInviteOpen(false)}>
                取消
              </Button>
              <Button
                type="submit"
                form="invite-member-form"
                loading={createInvite.isPending}
              >
                生成邀请链接
              </Button>
            </>
          )
        }
      >
        {createdInvite ? (
          <div className="space-y-4">
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
              邀请链接已生成，请复制并发送给成员。链接只能使用一次。
            </div>
            <div className="rounded-xl border border-line bg-stone-50 p-3">
              <p className="break-all text-xs text-muted">{createdInvite.url}</p>
            </div>
            <Button variant="secondary" className="w-full" onClick={copyInvite}>
              <Copy className="h-4 w-4" />
              复制邀请链接
            </Button>
            <p className="text-xs leading-relaxed text-soft">
              邀请角色：{createdInvite.role === 'admin' ? '管理员' : '成员'} · 有效期至{' '}
              {formatDate(createdInvite.expiresAt)}
            </p>
          </div>
        ) : (
          <form
            id="invite-member-form"
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              createInvite.mutate();
            }}
          >
            <Field label="邀请角色" htmlFor="invite-role">
              <Select
                id="invite-role"
                value={inviteRole}
                onChange={(event) =>
                  setInviteRole(event.target.value as 'admin' | 'member')
                }
              >
                <option value="member">成员</option>
                {/* 管理员选项只给 owner：admin 只能邀请 member，后端 InvitesService.create 会再拒一次 */}
                {isOwner ? <option value="admin">管理员</option> : null}
              </Select>
            </Field>
            <div className="rounded-xl bg-stone-50 px-4 py-3 text-xs leading-relaxed text-muted">
              新成员注册后会直接加入组织。管理员只能邀请普通成员；所有者可邀请管理员。
            </div>
          </form>
        )}
      </Dialog>

      <ConfirmDialog
        open={Boolean(removeTarget)}
        onClose={() => setRemoveTarget(null)}
        onConfirm={() => {
          if (removeTarget) removeMember.mutate(removeTarget.id);
        }}
        title="移除成员"
        description={`确定移除「${removeTarget?.name ?? ''}」吗？其在该组织的知识库授权和会话将被删除。`}
        confirmLabel="移除成员"
        busy={removeMember.isPending}
      />

      <ConfirmDialog
        open={Boolean(revokeTarget)}
        onClose={() => setRevokeTarget(null)}
        onConfirm={() => {
          if (revokeTarget) revokeInvite.mutate(revokeTarget.id);
        }}
        title="撤销邀请"
        description="撤销后，该链接将无法再被使用。"
        confirmLabel="撤销邀请"
        busy={revokeInvite.isPending}
      />
    </div>
  );
}
