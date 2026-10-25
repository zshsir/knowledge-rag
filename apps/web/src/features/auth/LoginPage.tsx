/**
 * 登录页（/login）：邮箱 + 密码，成功后回到 ?next= 指向的站内路径。
 *
 * 职责与边界：
 * - 只发 /auth/login（逻辑在 AuthProvider.login），不处理注册与邀请接受；
 *   底部「创建账号」只负责把 next 透传给 /register
 * - 已登录用户直接重定向：['me'] 已就绪/缓存命中时，渲染期发现 user 就返回 <Navigate>；
 *   冷启动时 /login 在 ProtectedRoute 之外，['me'] 未就绪的首帧仍会渲染一次表单
 * - 错误只展示 ApiError 的 message（后端给的失败原因），非 ApiError 的网络异常给通用兜底
 */
import { useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { AlertCircle, Eye, EyeOff } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Field, Input } from '../../components/ui/input';
import { ApiError } from '../../lib/api';
import { AuthLayout } from './AuthLayout';
import { useAuth } from './AuthProvider';

/**
 * 收敛 ?next=：只接受以单个 '/' 开头的站内路径。
 * 拒绝 '//evil.com' 这类协议相对 URL 与绝对 URL，防止登录后被带去外站（开放重定向）。
 */
function safeNext(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}

/**
 * 登录表单。
 * 步骤：
 * 1. 从查询串取 next（经 safeNext 消毒），控制「已登录则跳哪、注册链接带不带 next」
 * 2. 提交：先清错误、置 busy，调 login()——它成功时已写好 ['me'] 缓存
 * 3. 成功后 navigate(next, { replace: true })，用 replace 让登录页不留在历史栈里
 * 4. 失败把 ApiError.message 展示在表单顶部；busy 在 finally 复位
 */
export function LoginPage() {
  const { user, isLoading, login } = useAuth();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  // 步骤 1：next 只在 '/'、'/orgs/...' 这类站内路径里取值
  const next = safeNext(searchParams.get('next'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 已登录（且引导查询已结束）就没必要再看登录表单，直接去 next
  if (!isLoading && user) return <Navigate to={next} replace />;

  // 步骤 2–4：提交、跳转、错误兜底
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
      navigate(next, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '登录失败，请稍后重试');
    } finally {
      setBusy(false);
    }
  };

  return (
    // 品牌区与卡片外壳都在 AuthLayout 里，本页只提供文案、children（表单）与 footer（切换链接）
    <AuthLayout
      eyebrow="Welcome back"
      title="登录工作区"
      description="继续检索团队知识，或开始一次新的对话。"
      footer={
        <span>
          还没有账号？{' '}
          <Link
            to={`/register${next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`}
            className="font-medium text-accent hover:text-accent-dark"
          >
            创建账号
          </Link>
        </span>
      }
    >
      <form onSubmit={submit} className="space-y-5">
        {error ? (
          <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3.5 py-3 text-sm text-red-700">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        <Field label="邮箱" htmlFor="email">
          <Input
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@company.com"
            required
          />
        </Field>

        <Field label="密码" htmlFor="password">
          <div className="relative">
            <Input
              id="password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="至少 8 位字符"
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

        <Button type="submit" className="w-full" loading={busy}>
          登录
        </Button>
      </form>
    </AuthLayout>
  );
}
