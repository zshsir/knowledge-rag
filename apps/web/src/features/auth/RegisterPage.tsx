/**
 * 注册页（/register）：同一个表单承担两种注册方式，由 URL 上有没有 ?invite= 决定。
 *
 * 职责与边界：
 * - 无邀请：填姓名/邮箱/密码/组织名 → 后端新建用户并创建自己的组织
 * - 有邀请（?invite=<token>）：只读展示邀请来源，提交时把 inviteToken 交给 /auth/register；
 *   组织名输入框隐藏，因为加入哪个组织、什么角色由邀请决定，注册者无权选择
 *   （后端 auth.service 的 inviteToken 分支负责锁行、消费邀请、写 membership 与可选的 KB 授权）
 * - 边界：本页不「接受」邀请，只做注册；已登录用户走 JoinPage（/join/:token）
 * - 邀请信息只用于展示（GET /invites/:token），失效与否不影响提交，最终以后端校验为准
 */
import { useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { AlertCircle, Eye, EyeOff, Mail } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '../../components/ui/button';
import { Field, Input } from '../../components/ui/input';
import { Spinner } from '../../components/ui/spinner';
import { apiFetch, ApiError } from '../../lib/api';
import type { InviteInfo } from '../../lib/types';
import { AuthLayout } from './AuthLayout';
import { useAuth } from './AuthProvider';

function safeNext(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}

/**
 * 注册表单。
 * 步骤：
 * 1. 读 invite / next；invite 非空时用 ['invite-info', invite] 查一次邀请详情（retry:false，
 *    enabled 只在有 token 时打开，避免普通注册也打这个接口）
 * 2. 已登录用户（['me'] 已就绪/缓存命中时）直接跳 next；冷启动查询未就绪的首帧仍会渲染表单
 * 3. 提交时组装 body：invite 存在就只发 inviteToken，否则发 orgName——两个字段互斥，
 *    后端见到 inviteToken 会忽略 orgName，所以这里不把无用的空组织名一起发出去
 * 4. 成功后：邀请注册且响应里有组织时跳 /orgs/<organizations[0]>（即被邀请加入的组织）；
 *    普通注册一律跳 /，由 HomeRedirect 决定进哪个组织
 */
export function RegisterPage() {
  const { user, isLoading, register } = useAuth();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const invite = searchParams.get('invite') ?? '';
  const next = safeNext(searchParams.get('next'));
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [orgName, setOrgName] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 步骤 1：邀请详情只做展示用；查询失败也不阻塞注册，真正的校验在后端
  const inviteInfo = useQuery({
    queryKey: ['invite-info', invite],
    queryFn: () => apiFetch<InviteInfo>(`/invites/${invite}`),
    enabled: Boolean(invite),
    retry: false,
  });

  if (!isLoading && user) return <Navigate to={next} replace />;

  // 步骤 3–4：互斥地只发 inviteToken 或 orgName，成功后进第一个组织
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const data = await register({
        name,
        email,
        password,
        ...(invite ? { inviteToken: invite } : { orgName }),
      });
      const nextOrg = data.organizations[0]?.id;
      navigate(invite && nextOrg ? `/orgs/${nextOrg}` : '/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '注册失败，请稍后重试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      eyebrow={invite ? 'Join workspace' : 'Get started'}
      title={invite ? '加入组织' : '创建你的工作区'}
      description={
        invite
          ? '使用邀请链接注册后，你会自动加入对应组织。'
          : '创建账号并建立第一个组织，开始沉淀团队知识。'
      }
      footer={
        <span>
          已有账号？{' '}
          <Link
            to={
              invite
                ? `/login?next=${encodeURIComponent(`/join/${invite}`)}`
                : `/login${next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`
            }
            className="font-medium text-accent hover:text-accent-dark"
          >
            直接登录
          </Link>
        </span>
      }
    >
      <form onSubmit={submit} className="space-y-5">
        {/* 邀请注册时顶部只读展示来源组织与链接有效性，不给「换一个组织」的入口 */}
        {invite ? (
          <div className="flex items-center gap-3 rounded-xl border border-indigo-100 bg-accent-soft px-3.5 py-3">
            <Mail className="h-4 w-4 text-accent" />
            <div className="text-sm text-indigo-900">
              {inviteInfo.isLoading ? (
                <span className="flex items-center gap-2 text-indigo-700">
                  <Spinner className="h-3.5 w-3.5" /> 正在读取邀请…
                </span>
              ) : inviteInfo.data ? (
                <>
                  邀请来自 <span className="font-semibold">{inviteInfo.data.orgName}</span>
                  {!inviteInfo.data.valid ? (
                    <span className="ml-2 text-xs text-red-600">链接已失效</span>
                  ) : null}
                </>
              ) : (
                <span className="text-red-600">邀请链接无效</span>
              )}
            </div>
          </div>
        ) : null}

        {error ? (
          <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3.5 py-3 text-sm text-red-700">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        <Field label="姓名" htmlFor="name">
          <Input
            id="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="你的名字"
            autoComplete="name"
            required
          />
        </Field>

        <Field label="邮箱" htmlFor="email">
          <Input
            id="email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@company.com"
            autoComplete="email"
            required
          />
        </Field>

        {/* 8–72 与后端 RegisterDto 一致：上限来自 bcrypt 只认前 72 字节，超过部分会被静默丢弃 */}
        <Field label="密码" htmlFor="password" hint="8–72 位字符">
          <div className="relative">
            <Input
              id="password"
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="设置登录密码"
              autoComplete="new-password"
              minLength={8}
              maxLength={72}
              className="pr-11"
              required
            />
            <button
              type="button"
              onClick={() => setShowPassword((value) => !value)}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-soft transition hover:bg-stone-100 hover:text-ink"
              aria-label={showPassword ? '隐藏密码' : '显示密码'}
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </Field>

        {!invite ? (
          <Field label="组织名称" htmlFor="orgName" hint="可稍后修改">
            <Input
              id="orgName"
              value={orgName}
              onChange={(event) => setOrgName(event.target.value)}
              placeholder="例如：产品团队"
              required
            />
          </Field>
        ) : null}

        <Button type="submit" className="w-full" loading={busy}>
          创建账号
        </Button>
      </form>
    </AuthLayout>
  );
}
