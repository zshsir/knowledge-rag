/**
 * 知识库成员页（/kbs/:kbId/members）：访问范围切换 + 显式授权成员列表 + 添加成员/发邀请。
 *
 * 职责与边界：
 * - 数据全部走 HTTP：['kb-members'] 拿显式授权与继承的 manager，['org-members'] 拿组织成员做候选；
 *   两条查询都只在本人 effectivePermission 为 manager 时才发（非 manager 见下方整块提示，直接早退）
 * - 列表分两段渲染：inherited（组织 owner/admin 与库创建者，由后端推导、不可改不可删）在前，
 *   members（knowledge_base_members 里的显式授权，可改权限/可移除）在后
 * - 边界：这里不判「能不能加」——服务端会拒绝给创建者或 owner/admin 写授权行；
 *   前端只是把已在列表里的人从候选里剔掉（见 kb-member-utils.ts）
 * - 领域缺陷提示：按 userId 直接加的那条路径，后端 add() 不校验该 userId 是否属于本组织
 *   （只拒绝创建者与组织 owner/admin 这两类已有 manager 权限的人）。本页的候选来自 ['org-members']，正常操作不会传组织外的人；
 *   但绕过 UI 直接请求仍可给外组织成员写进一行授权——他读不到任何数据，却会出现在本库成员列表里
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Copy,
  Globe2,
  Lock,
  Mail,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
} from 'lucide-react';
import { Avatar } from '../../components/ui/avatar';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { ConfirmDialog } from '../../components/ui/confirm-dialog';
import { Dialog } from '../../components/ui/dialog';
import { EmptyState } from '../../components/ui/empty-state';
import { Field, Input } from '../../components/ui/input';
import { Select } from '../../components/ui/select';
import { PageLoader } from '../../components/ui/spinner';
import { useToast } from '../../components/ui/toast';
import { apiFetch, ApiError } from '../../lib/api';
import type {
  AccessMode,
  CreatedInvite,
  KbMember,
  KbMemberAddResult,
  KbMemberList,
  KbPermission,
  KnowledgeBase,
  OrgMember,
} from '../../lib/types';
import { cn } from '../../lib/cn';
import { copyText } from '../../lib/clipboard';
import { formatDate } from '../../lib/format';
import { computeAddableCandidates } from './kb-member-utils';
import { useKbContext } from './kb-context';

const permissionLabels: Record<KbPermission, string> = {
  viewer: '查看',
  editor: '编辑',
  manager: '管理',
};

// 权限单选下的说明文案：与后端能力表对齐（查看=问答+下载，编辑=再＋上传/删除，管理=再＋成员与设置）
const permissionHints: Record<KbPermission, string> = {
  viewer: '可问答与下载文档',
  editor: '可上传、删除文档',
  manager: '可管理成员与设置',
};

/**
 * 知识库成员与授权管理。
 * 步骤：
 * 1. 从 outlet context 取 kb / orgId / kbId（不自己再请求库详情）
 * 2. 拉两条查询：显式授权 + 继承 manager、组织成员候选；非 manager 直接渲染无权限提示
 * 3. 访问范围卡片：切到 restricted 会立刻让未授权成员失去访问，所以先弹 ConfirmDialog；
 *    切回 org 是放宽，直接提交
 * 4. 成员列表：inherited 行只读（来源 + 固定「管理」），members 行可改权限、可移除（二次确认）
 * 5. 添加成员对话框：两种模式共用同一份权限单选，提交后按结果分支（见 addByEmail）
 */
export function KbMembersPage() {
  const { kb, orgId, kbId } = useKbContext();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [addOpen, setAddOpen] = useState(false);
  const [dialogView, setDialogView] = useState<'select' | 'invite-done'>('select');
  const [addMode, setAddMode] = useState<'member' | 'email'>('member');
  const [emailInput, setEmailInput] = useState('');
  const [createdInvite, setCreatedInvite] = useState<CreatedInvite | null>(null);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [selectedPermission, setSelectedPermission] = useState<KbPermission>('viewer');
  const [pendingAccessMode, setPendingAccessMode] = useState<AccessMode | null>(null);
  const [removeTarget, setRemoveTarget] = useState<KbMember | null>(null);

  // 步骤 2a：显式授权列表。enabled 跟 effectivePermission 走，非 manager 时不发请求（后端也会拒）
  const membersQuery = useQuery({
    queryKey: ['kb-members', orgId, kbId],
    queryFn: () => apiFetch<KbMemberList>(`/orgs/${orgId}/knowledge-bases/${kbId}/members`),
    enabled: kb.effectivePermission === 'manager',
    retry: false,
  });

  // 步骤 2b：组织成员全集，仅用于「选择组织成员」下拉的候选；打开对话框时还会再失效一次
  const orgMembersQuery = useQuery({
    queryKey: ['org-members', orgId],
    queryFn: () => apiFetch<OrgMember[]>(`/orgs/${orgId}/members`),
    enabled: kb.effectivePermission === 'manager',
  });

  // 步骤 3：访问范围。org → restricted 需要二次确认；restricted → org 直接生效
  const updateAccessMode = useMutation({
    mutationFn: (accessMode: AccessMode) =>
      apiFetch<KnowledgeBase>(`/orgs/${orgId}/knowledge-bases/${kbId}`, {
        method: 'PATCH',
        body: JSON.stringify({ accessMode }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['kb', orgId, kbId] });
      queryClient.invalidateQueries({ queryKey: ['knowledge-bases', orgId] });
      queryClient.invalidateQueries({ queryKey: ['kb-members', orgId, kbId] });
      toast({ title: '访问范围已更新', type: 'success' });
    },
    onError: (error) => {
      toast({
        title: '更新访问范围失败',
        description: error instanceof ApiError ? error.message : '请稍后重试',
        type: 'error',
      });
    },
  });

  // 步骤 5a：模式一「选择组织成员」——只发 userId。选中项来自候选下拉，因此正常路径下是本组织的人；
  // 后端这条分支不校验组织归属（见文件头），所以这里能做的只有不提供组织外的选项
  const addMember = useMutation({
    mutationFn: () =>
      apiFetch(`/orgs/${orgId}/knowledge-bases/${kbId}/members`, {
        method: 'POST',
        body: JSON.stringify({
          userId: selectedUserId,
          permission: selectedPermission,
        }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['kb-members', orgId, kbId] });
      queryClient.invalidateQueries({ queryKey: ['knowledge-bases', orgId] });
      setAddOpen(false);
      setSelectedUserId('');
      setSelectedPermission('viewer');
      toast({ title: '成员授权已添加', type: 'success' });
    },
  });

  const updatePermission = useMutation({
    mutationFn: (input: { userId: string; permission: KbPermission }) =>
      apiFetch(`/orgs/${orgId}/knowledge-bases/${kbId}/members/${input.userId}`, {
        method: 'PATCH',
        body: JSON.stringify({ permission: input.permission }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['kb-members', orgId, kbId] });
      toast({ title: '权限已更新', type: 'success' });
    },
  });

  const removeMember = useMutation({
    mutationFn: (userId: string) =>
      apiFetch(`/orgs/${orgId}/knowledge-bases/${kbId}/members/${userId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['kb-members', orgId, kbId] });
      queryClient.invalidateQueries({ queryKey: ['knowledge-bases', orgId] });
      setRemoveTarget(null);
      toast({ title: '成员授权已移除', type: 'success' });
    },
  });

  // 步骤 5b：模式二「按邮箱添加」。同一路由换用 email 字段，后端返回两种结果，见 onSuccess
  const addByEmail = useMutation({
    mutationFn: (email: string) =>
      apiFetch<KbMemberAddResult>(`/orgs/${orgId}/knowledge-bases/${kbId}/members`, {
        method: 'POST',
        body: JSON.stringify({ email, permission: selectedPermission }),
      }),
    onSuccess: (result) => {
      // 步骤 5b 续：两条结果分支——
      // 1）邮箱已注册：后端把他补进组织（若非成员）并当场写授权，返回 { added: true }。
      //    这里关闭对话框并提示「已添加并加入组织」；同时失效 org-members，因为组织成员集合刚刚变了
      // 2）邮箱查无账号：后端只签一条知识库作用域的一次性邀请（7 天有效），返回 { invited, invite }，
      //    此时一行授权都没写。切到 invite-done 视图展示链接、让用户复制转发；
      //    对方注册或登录后接受链接，才会同时写入 membership 与 KB 授权
      queryClient.invalidateQueries({ queryKey: ['kb-members', orgId, kbId] });
      queryClient.invalidateQueries({ queryKey: ['org-members', orgId] });
      queryClient.invalidateQueries({ queryKey: ['knowledge-bases', orgId] });
      if (result.invited && result.invite) {
        setCreatedInvite(result.invite);
        setDialogView('invite-done');
        toast({ title: '邀请链接已生成', type: 'success' });
      } else {
        setAddOpen(false);
        setEmailInput('');
        setSelectedPermission('viewer');
        toast({ title: '成员已添加并加入组织', type: 'success' });
      }
    },
  });

  // 步骤 2 续：非 manager 早退。此处只阻挡渲染，接口侧另有 manager 门槛
  if (kb.effectivePermission !== 'manager') {
    return (
      <div className="rounded-2xl border border-line bg-white p-8 text-center">
        <ShieldCheck className="mx-auto h-8 w-8 text-soft" />
        <h2 className="mt-3 text-base font-semibold text-ink">仅知识库管理者可查看</h2>
        <p className="mt-1.5 text-sm text-muted">
          你当前没有管理该知识库成员的权限。
        </p>
      </div>
    );
  }

  if (membersQuery.isLoading) return <PageLoader label="正在加载成员授权…" />;

  const members = membersQuery.data?.members ?? [];
  // inherited 按 userId 再去一次重：后端 UNION + Set 已经保证一人一行，这里是防御性的，
  // 避免接口将来改成 UNION ALL 时列表重复渲染、候选过滤也跟着出错
  const inherited = Array.from(
    new Map(
      (membersQuery.data?.inherited ?? []).map((member) => [member.userId, member]),
    ).values(),
  );
  const orgMembers = orgMembersQuery.data ?? [];
  // 候选 = 组织成员 −（显式授权 ∪ 继承 manager）。已在任一集合里的人不再出现，见 kb-member-utils.ts
  const candidates = computeAddableCandidates(orgMembers, members, inherited);
  // 四个增删改 mutation 的错误都收敛到这一处展示；updateAccessMode 不在此列，它自己弹 toast
  const error =
    addMember.error ??
    updatePermission.error ??
    removeMember.error ??
    addByEmail.error;

  const switchAccessMode = (mode: AccessMode) => {
    // 步骤 3：点当前项不重复提交；收窄到 restricted 先挂起、等确认框，放宽则立即生效
    if (mode === kb.accessMode) return;
    if (mode === 'restricted') {
      setPendingAccessMode(mode);
      return;
    }
    updateAccessMode.mutate(mode);
  };

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold text-ink">访问与成员授权</h2>
        <p className="mt-1 text-sm text-muted">
          控制谁可以查看、编辑或管理这个知识库。组织所有者与管理员始终拥有管理权限。
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {[
          {
            value: 'org' as const,
            icon: Globe2,
            title: '组织公开',
            text: '组织内所有成员默认可问答与下载文档。',
          },
          {
            value: 'restricted' as const,
            icon: Lock,
            title: '指定成员',
            text: '仅创建者、组织管理员与下方授权成员可访问。',
          },
        ].map((option) => {
          const active = kb.accessMode === option.value;
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => switchAccessMode(option.value)}
              disabled={updateAccessMode.isPending}
              className={cn(
                'rounded-2xl border p-4 text-left outline-none transition',
                active
                  ? 'border-accent/50 bg-accent-soft/60 ring-2 ring-accent/10'
                  : 'border-line bg-white hover:border-line-strong',
              )}
            >
              <div className="flex items-center gap-2">
                <option.icon className={cn('h-4 w-4', active ? 'text-accent' : 'text-soft')} />
                <span className="text-sm font-medium text-ink">{option.title}</span>
                {active ? <Badge tone="indigo">当前</Badge> : null}
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-muted">{option.text}</p>
            </button>
          );
        })}
      </div>

      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-3 text-sm text-red-700">
          {error instanceof ApiError ? error.message : '操作失败，请稍后重试'}
        </div>
      ) : null}

      <div className="rounded-2xl border border-line bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div>
            <h3 className="text-sm font-semibold text-ink">成员授权</h3>
            <p className="mt-0.5 text-xs text-soft">显式授予的成员与继承权限</p>
          </div>
          <Button
            size="sm"
            onClick={() => {
              // 步骤 5：每次打开都先复位到「选择组织成员」初始态，并失效组织成员查询。
              // 失效的必要性：上一轮「按邮箱添加已注册账号」会把对方写进组织成员，邀请也可能在别处被接受，
              // 缓存里的候选可能已经缺人/多人；该查询在 manager 下始终 active，失效即触发重新拉取
              setDialogView('select');
              setAddMode('member');
              setCreatedInvite(null);
              setEmailInput('');
              setSelectedUserId('');
              setSelectedPermission('viewer');
              queryClient.invalidateQueries({ queryKey: ['org-members', orgId] });
              setAddOpen(true);
            }}
          >
            <UserPlus className="h-4 w-4" />
            添加成员
          </Button>
        </div>

        <div className="divide-y divide-line">
          {inherited.map((member) => (
            <div key={member.userId} className="flex items-center gap-3 px-5 py-3.5">
              <Avatar name={member.name} size="md" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink">{member.name}</p>
                <p className="truncate text-xs text-soft">{member.email}</p>
              </div>
              <Badge tone="neutral">{member.source ?? '继承权限'}</Badge>
              <Badge tone="indigo">管理</Badge>
            </div>
          ))}

          {members.map((member) => (
            <div key={member.userId} className="flex flex-col gap-3 px-5 py-3.5 sm:flex-row sm:items-center">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <Avatar name={member.name} size="md" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">{member.name}</p>
                  <p className="truncate text-xs text-soft">{member.email}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 sm:justify-end">
                <select
                  value={member.permission}
                  disabled={updatePermission.isPending}
                  onChange={(event) =>
                    updatePermission.mutate({
                      userId: member.userId,
                      permission: event.target.value as KbPermission,
                    })
                  }
                  className="h-9 rounded-lg border border-line bg-white px-2 text-xs text-ink outline-none focus:border-accent/60"
                  aria-label={`修改 ${member.name} 的权限`}
                >
                  {(['viewer', 'editor', 'manager'] as KbPermission[]).map((permission) => (
                    <option key={permission} value={permission}>
                      {permissionLabels[permission]}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => setRemoveTarget(member)}
                  className="rounded-lg p-2 text-muted transition hover:bg-red-50 hover:text-red-600"
                  aria-label={`移除 ${member.name}`}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}

          {!members.length ? (
            <div className="px-5 py-8 text-center text-xs leading-relaxed text-soft">
              {kb.accessMode === 'restricted'
                ? '还没有显式授权成员。当前仅创建者与组织管理员可访问，点击右上角「添加成员」进行授权。'
                : '还没有显式授权成员。组织公开时，所有成员默认可查看；你也可以单独授予更高权限。'}
            </div>
          ) : null}
        </div>
      </div>

      <div className="rounded-2xl border border-line bg-stone-50/60 p-4">
        <div className="flex items-start gap-2 text-xs leading-relaxed text-muted">
          <Users className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
          <p>
            权限说明：<strong className="text-ink">查看</strong>可问答与下载；
            <strong className="text-ink">编辑</strong>可上传与删除文档；
            <strong className="text-ink">管理</strong>可修改知识库设置与成员授权。
          </p>
        </div>
      </div>

      <Dialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        // 同一个 Dialog 承载两个视图：select 是表单，invite-done 是「链接已生成」的结果页。
        // 标题/描述/底部按钮都按 dialogView 切换，表单在 invite-done 下整体不渲染
        title={dialogView === 'select' ? '添加知识库成员' : '邀请新成员'}
        description={
          dialogView === 'select'
            ? '选择组织成员，或按邮箱添加组织外的人并授权。'
            : '对方通过链接注册后，会自动加入组织并获得该知识库权限。'
        }
        footer={
          dialogView === 'select' ? (
            <>
              <Button variant="secondary" onClick={() => setAddOpen(false)}>
                取消
              </Button>
              <Button
                type="submit"
                form="add-kb-member-form"
                loading={addMode === 'email' ? addByEmail.isPending : addMember.isPending}
                disabled={addMode === 'email' ? !emailInput.trim() : !selectedUserId}
              >
                {addMode === 'email' ? '添加' : '添加授权'}
              </Button>
            </>
          ) : (
            <Button onClick={() => setAddOpen(false)}>完成</Button>
          )
        }
      >
        {dialogView === 'invite-done' && createdInvite ? (
          // 邀请结果视图：链接只在这里出现一次（后端只在签发响应里返回原始 token），
          // 所以文案强调「复制并发送」；过期时间与授予的权限也一并回显，避免转发时说不清
          <div className="space-y-4">
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
              邀请链接已生成，请复制并发送给对方。链接只能使用一次，7 天内有效。
            </div>
            <div className="rounded-xl border border-line bg-stone-50 p-3">
              <p className="break-all text-xs text-muted">{createdInvite.url}</p>
            </div>
            <Button
              variant="secondary"
              className="w-full"
              onClick={async () => {
                try {
                  await copyText(createdInvite.url);
                  toast({ title: '邀请链接已复制', type: 'success' });
                } catch {
                  toast({ title: '复制失败，请手动选择链接', type: 'error' });
                }
              }}
            >
              <Copy className="h-4 w-4" />
              复制邀请链接
            </Button>
            <p className="text-xs leading-relaxed text-soft">
              有效期至 {formatDate(createdInvite.expiresAt)}。对方注册加入组织后，将自动获得
              「{permissionLabels[selectedPermission]}」权限。
            </p>
          </div>
        ) : (
          <form
            id="add-kb-member-form"
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (addMode === 'email') addByEmail.mutate(emailInput.trim());
              else addMember.mutate();
            }}
          >
            {/* 两个模式只是切换表单字段，提交走同一个 POST：给 userId 走授权，给 email 由后端决定是否发邀请 */}
            <div className="grid grid-cols-2 gap-1 rounded-xl border border-line bg-stone-50 p-1">
              <button
                type="button"
                onClick={() => setAddMode('member')}
                className={cn(
                  'rounded-lg px-3 py-1.5 text-xs font-medium transition',
                  addMode === 'member'
                    ? 'bg-white text-ink shadow-sm'
                    : 'text-muted hover:text-ink',
                )}
              >
                选择组织成员
              </button>
              <button
                type="button"
                onClick={() => setAddMode('email')}
                className={cn(
                  'flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition',
                  addMode === 'email'
                    ? 'bg-white text-ink shadow-sm'
                    : 'text-muted hover:text-ink',
                )}
              >
                <Mail className="h-3.5 w-3.5" />
                按邮箱添加
              </button>
            </div>

            {addMode === 'member' ? (
              // 模式一：候选为空（全都授权过了，或组织只有自己）时不渲染空下拉，改为提示切到邮箱模式
              candidates.length ? (
                <Field label="组织成员" htmlFor="kb-member-user">
                  <Select
                    id="kb-member-user"
                    value={selectedUserId}
                    onChange={(event) => setSelectedUserId(event.target.value)}
                    required
                  >
                    <option value="">选择成员</option>
                    {candidates.map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.name} · {member.email}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : (
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                  组织内暂无可添加的成员，或所有成员都已获得授权。可切换到「按邮箱添加」邀请组织外的人。
                </div>
              )
            ) : (
              <>
                <Field label="邮箱" htmlFor="kb-member-email">
                  <Input
                    id="kb-member-email"
                    type="email"
                    required
                    placeholder="name@example.com"
                    value={emailInput}
                    onChange={(event) => setEmailInput(event.target.value)}
                  />
                </Field>
                <div className="rounded-xl bg-stone-50 px-4 py-3 text-xs leading-relaxed text-muted">
                  {/* 两种结局与后端 add() 的两条分支一一对应：账号存在=当场入组+授权；不存在=只发链接 */}
                  已注册账号会直接加入组织并获得权限；未注册邮箱将生成一次性邀请链接，对方注册后自动加入组织并授权。
                </div>
              </>
            )}

            <Field label="权限">
              {/* 两个模式共用这份权限：直接授权时随 POST 当场写入；发邀请时随邀请存进 kb_permission，接受后才落成授权行 */}
              <div className="space-y-2">
                {(['viewer', 'editor', 'manager'] as KbPermission[]).map((permission) => (
                  <label
                    key={permission}
                    className={cn(
                      'flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition',
                      selectedPermission === permission
                        ? 'border-accent/50 bg-accent-soft/60'
                        : 'border-line hover:border-line-strong',
                    )}
                  >
                    <input
                      type="radio"
                      name="permission"
                      value={permission}
                      checked={selectedPermission === permission}
                      onChange={() => setSelectedPermission(permission)}
                      className="mt-1 accent-indigo-600"
                    />
                    <span>
                      <span className="block text-sm font-medium text-ink">
                        {permissionLabels[permission]}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted">
                        {permissionHints[permission]}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </Field>
          </form>
        )}
      </Dialog>

      <ConfirmDialog
        open={Boolean(pendingAccessMode)}
        onClose={() => setPendingAccessMode(null)}
        onConfirm={() => {
          if (pendingAccessMode) {
            updateAccessMode.mutate(pendingAccessMode);
            setPendingAccessMode(null);
          }
        }}
        title="切换为指定成员"
        description="切换后，未单独授权的普通成员将立即失去访问权限（组织所有者与管理员不受影响）。"
        confirmLabel="确认切换"
        danger={false}
        busy={updateAccessMode.isPending}
      />

      <ConfirmDialog
        open={Boolean(removeTarget)}
        onClose={() => setRemoveTarget(null)}
        onConfirm={() => {
          if (removeTarget) removeMember.mutate(removeTarget.userId);
        }}
        title="移除成员授权"
        description={`确定移除「${removeTarget?.name ?? ''}」的访问权限吗？`}
        busy={removeMember.isPending}
      />
    </div>
  );
}
