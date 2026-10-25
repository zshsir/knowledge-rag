/**
 * 创建组织页（/orgs/new）：独立全屏页，不在 AppShell 的组织布局里。
 *
 * 非显然行为：
 * - 已在任何组织里的用户会看到「返回工作区」；一个组织都没有时这是新用户的落点
 * - 只收组织名；后端建组织时在事务里把创建人写成 owner（OrganizationsService.create）
 * - 名称输入框这里只有 required、没有 maxLength（设置页那个输入框有 60 的限制），
 *   长度上限实际由后端 CreateOrgDto 的 @Length(1,60) 决定，超长会以 ApiError.message 展示
 * - 成功后先 refreshMe() 再跳转：跳转后的 AppShell 依赖 ['me'] 里出现这个新组织
 * 边界：不负责登录/注册（AuthProvider）、不处理邀请（JoinPage）。
 */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Building2 } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Field, Input } from '../../components/ui/input';
import { Logo } from '../../components/ui/logo';
import { useToast } from '../../components/ui/toast';
import { apiFetch, ApiError } from '../../lib/api';
import type { Organization } from '../../lib/types';
import { useAuth } from '../auth/AuthProvider';

/**
 * 建组织表单。步骤：
 * 1. 校验交给原生 required；提交时清错误、置 busy
 * 2. POST /orgs { name }——创建人自动成为 owner，组织与成员关系由后端同一事务写入
 * 3. refreshMe 刷新 ['me']；成功后 replace 跳到新组织首页（返回键不会回到这个一次性表单）
 * 4. 失败展示 ApiError.message，busy 在 finally 复位
 */
export function OrgOnboardingPage() {
  const { organizations, refreshMe } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const org = await apiFetch<Organization>('/orgs', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      await refreshMe();
      toast({ title: '组织已创建', description: `欢迎来到 ${org.name}`, type: 'success' });
      navigate(`/orgs/${org.id}`, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '创建组织失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex min-h-screen flex-col bg-canvas">
      <div className="absolute inset-x-0 top-0 h-72 bg-gradient-to-b from-indigo-50/80 to-transparent" />
      <header className="relative z-10 mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-6">
        <Logo />
        {/* 已有组织的人才给「返回」；新用户没有可回的工作区 */}
        {organizations.length ? (
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-muted transition hover:text-ink"
          >
            <ArrowLeft className="h-4 w-4" />
            返回工作区
          </Link>
        ) : null}
      </header>

      <main className="relative z-10 flex flex-1 items-center justify-center px-5 pb-16">
        <div className="w-full max-w-md animate-slide-up rounded-3xl border border-line bg-white p-8 shadow-xl shadow-slate-900/[0.04]">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-accent">
            <Building2 className="h-6 w-6" />
          </div>
          <h1 className="mt-5 text-xl font-semibold tracking-tight text-ink">
            {organizations.length ? '创建新的组织' : '创建你的第一个组织'}
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            组织是知识与成员的边界。你将成为所有者，可以邀请成员并分配权限。
          </p>

          <form onSubmit={submit} className="mt-7 space-y-5">
            {error ? (
              <div className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-3 text-sm text-red-700">
                {error}
              </div>
            ) : null}
            <Field label="组织名称" htmlFor="org-name">
              {/* 只有 required；长度上限在后端 DTO（1–60），超长时展示后端返回的校验文案 */}
              <Input
                id="org-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="例如：产品与研发中心"
                autoFocus
                required
              />
            </Field>
            <Button type="submit" className="w-full" loading={busy}>
              创建组织
              <ArrowRight className="h-4 w-4" />
            </Button>
          </form>

          <p className="mt-5 text-center text-xs leading-relaxed text-soft">
            收到邀请？打开邀请链接即可直接加入已有组织。
          </p>
        </div>
      </main>
    </div>
  );
}
