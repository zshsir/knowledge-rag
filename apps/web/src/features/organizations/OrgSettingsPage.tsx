/**
 * 组织设置页：改名 + 展示「我的角色 / 组织 ID」。
 *
 * 非显然行为：
 * - 只有组织名可以编辑；后端 PATCH /orgs/:orgId 的 DTO 也只有 name 一个字段（无 description）
 * - 改名是 owner 专属：非 owner 的输入框 disabled 且不渲染保存按钮，后端 OrganizationsService.rename
 *   也会对 admin/member 返回 403
 * - 组织数据来自 AuthProvider 的 ['me'] 缓存，成功后必须 refreshMe() 才能在侧栏等处看到新名字
 * 边界：不做成员、邀请与知识库授权（各有独立页面）；组织不可删除，本页也没有删除入口。
 */
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { Building2, Copy, Info, ShieldCheck } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Field, Input } from '../../components/ui/input';
import { Badge } from '../../components/ui/badge';
import { useToast } from '../../components/ui/toast';
import { apiFetch, ApiError } from '../../lib/api';
import { copyText } from '../../lib/clipboard';
import { useAuth } from '../auth/AuthProvider';

/**
 * 组织设置主体。
 * 步骤：
 * 1. 从 AuthProvider 的组织列表定位当前 org（AppShell 已保证它存在），初始化名称输入框
 * 2. 用 effect 跟随 org.name 变化回填——refreshMe 拿到新名字后输入框与服务端保持一致
 * 3. 提交 PATCH /orgs/:orgId；成功后 refreshMe 刷新全局组织列表
 * 4. 无 org 时返回 null（正常路由下不会发生，属防御）
 */
export function OrgSettingsPage() {
  const { orgId = '' } = useParams();
  const { organizations, refreshMe } = useAuth();
  const { toast } = useToast();
  const org = organizations.find((item) => item.id === orgId);
  const [name, setName] = useState(org?.name ?? '');

  // 组织列表刷新（如改名成功后 refreshMe）时同步输入框；否则会停留在旧名字
  useEffect(() => {
    if (org) setName(org.name);
  }, [org]);

  /** 改名：成功后 refreshMe 而不是单独失效某个查询——组织列表就存在 ['me'] 里 */
  const rename = useMutation({
    mutationFn: () =>
      apiFetch(`/orgs/${orgId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      }),
    onSuccess: async () => {
      await refreshMe();
      toast({ title: '组织名称已更新', type: 'success' });
    },
  });

  if (!org) return null;

  // 角色只影响改名权限与角色徽标；本页没有其它写操作
  const isOwner = org.role === 'owner';
  const error = rename.error;

  /** 复制组织 ID（纯文本），失败时只提示，不影响页面其它功能 */
  const copyOrgId = async () => {
    try {
      await copyText(org.id);
      toast({ title: '组织 ID 已复制', type: 'success' });
    } catch {
      toast({ title: '复制失败', type: 'error' });
    }
  };

  return (
    <div className="animate-fade-in space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">组织设置</h1>
        <p className="mt-1.5 text-sm text-muted">管理组织的基础信息与身份标识。</p>
      </div>

      <div className="rounded-2xl border border-line bg-white p-5 shadow-sm sm:p-6">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-soft text-accent">
            <Building2 className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-ink">组织信息</h2>
            <p className="mt-0.5 text-xs text-muted">名称会显示在侧栏和邀请页面中。</p>
          </div>
        </div>

        <form
          className="mt-6 max-w-lg space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            rename.mutate();
          }}
        >
          {error ? (
            <div className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-3 text-sm text-red-700">
              {error instanceof ApiError ? error.message : '保存失败，请稍后重试'}
            </div>
          ) : null}

          <Field label="组织名称" htmlFor="org-settings-name" hint={isOwner ? undefined : '仅所有者可修改'}>
            {/* maxLength=60 与后端 UpdateOrgDto 的 @Length(1,60) 对齐；disabled 只是界面收敛，后端仍会查角色 */}
            <Input
              id="org-settings-name"
              value={name}
              disabled={!isOwner}
              maxLength={60}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-line bg-stone-50/70 px-4 py-3">
              <p className="text-[11px] font-medium text-soft">你的角色</p>
              <div className="mt-1.5">
                <Badge tone={isOwner ? 'indigo' : org.role === 'admin' ? 'success' : 'neutral'}>
                  {org.role === 'owner' ? '所有者' : org.role === 'admin' ? '管理员' : '成员'}
                </Badge>
              </div>
            </div>
            <div className="rounded-xl border border-line bg-stone-50/70 px-4 py-3">
              <p className="text-[11px] font-medium text-soft">组织 ID</p>
              <button
                type="button"
                onClick={copyOrgId}
                className="mt-1.5 flex w-full items-center justify-between gap-2 text-left text-xs text-muted transition hover:text-ink"
              >
                <span className="truncate font-mono">{org.id}</span>
                <Copy className="h-3.5 w-3.5 shrink-0" />
              </button>
            </div>
          </div>

          {isOwner ? (
            // 名称去空白后为空或与原名相同就不让提交：前者会 trim 成空串写库、后者是无意义写入；
            // 后端 rename 不比对原名，同值 PATCH 也会成功——这里只是拦掉坏写入，不是靠 400 兜底
            <Button type="submit" loading={rename.isPending} disabled={!name.trim() || name === org.name}>
              保存修改
            </Button>
          ) : null}
        </form>
      </div>

      <div className="flex items-start gap-2 rounded-2xl border border-line bg-stone-50/60 p-4 text-xs leading-relaxed text-muted">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
        <p>
          组织是资源和权限的边界。邀请成员、配置角色，以及为知识库单独授权，都在对应页面完成。
        </p>
      </div>

      <div className="flex items-start gap-2 rounded-2xl border border-line bg-white p-4 text-xs leading-relaxed text-muted">
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
        <p>组织所有者与管理员自动拥有所有知识库的管理权限，普通成员由知识库授权决定。</p>
      </div>
    </div>
  );
}
