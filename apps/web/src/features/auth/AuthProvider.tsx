/**
 * 全局登录态：把「我是谁、我在哪些组织里」收敛成一条 React Query 查询 ['me']，再以 context 暴露。
 *
 * 职责与边界：
 * - 唯一数据源是 GET /auth/me 的返回（user + organizations）。未登录不是错误：接口 401 被翻译成
 *   data = null，这样「还没登录」和「请求失败」在 UI 上不会混为一谈
 * - 只负责维护缓存与派发登录/注册/登出请求，不做跳转。「未登录就跳登录页」的决策在
 *   app/ProtectedRoute.tsx（它读 user + isLoading），本文件刻意不持有 navigate，避免两处同时跳转
 * - 收到 lib/api 派发的全局 auth:unauthorized 时只清 ['me']，同样不跳转——见下面 effect 的说明
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '../../lib/api';
import type { MeResponse, Organization, User } from '../../lib/types';

interface RegisterInput {
  name: string;
  email: string;
  password: string;
  orgName?: string;
  inviteToken?: string;
}

interface AuthContextValue {
  user: User | null;
  organizations: Organization[];
  isLoading: boolean;
  error: Error | null;
  login: (email: string, password: string) => Promise<MeResponse>;
  register: (input: RegisterInput) => Promise<MeResponse>;
  logout: () => Promise<void>;
  refreshMe: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * 会话引导：应用启动时拉一次 /auth/me 决定登录态，并把登录/注册/登出三个动作挂到 context 上。
 * 步骤：
 * 1. useQuery(['me']) 拉当前会话；401 直接当成「没登录」（data=null），其余错误照常抛出，
 *    retry:false 只作用于非 401 错误（401 已在 queryFn 转成 null，不会进入重试），这类失败交给用户刷新
 * 2. 订阅 window 上的 auth:unauthorized：任何 apiFetch 收到 401 都会派发它，这里统一把 ['me']
 *    置空，于是 useAuth 的消费方（含 ProtectedRoute）在下一帧就看到 user=null 并自行处理跳转
 * 3. login/register 成功后把响应直接写进 ['me'] 缓存，省掉一次回源；logout 无论请求成败都清缓存
 * 4. useMemo 组装 context value，只在 user/loading/error 变化时换引用
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const query = useQuery<MeResponse | null>({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await apiFetch<MeResponse>('/auth/me');
      } catch (error) {
        // 步骤 1：401 = 没有有效 session，属于正常初始态；只有非 401 才向上抛
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
    retry: false,
    // 30 秒内不重复回源：登录态变化都由本文件主动写缓存，无需靠短期轮询兜底
    staleTime: 30_000,
  });

  useEffect(() => {
    const onUnauthorized = () => {
      // 步骤 2：只清缓存，不在这里 navigate。跳转交给 ProtectedRoute——它按当前路由算出 next，
      // 若在此处跳转会与路由层的判断重复，且拿不到 location，只能跳回首页
      queryClient.setQueryData(['me'], null);
    };
    window.addEventListener('auth:unauthorized', onUnauthorized);
    return () => window.removeEventListener('auth:unauthorized', onUnauthorized);
  }, [queryClient]);

  // 步骤 3a：登录成功即用响应填充 ['me']，调用方无需再 refreshMe
  const login = async (email: string, password: string) => {
    const data = await apiFetch<MeResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    queryClient.setQueryData(['me'], data);
    return data;
  };

  const register = async (input: RegisterInput) => {
    // 步骤 3b：注册（含邀请注册）同样直接落缓存；响应里的 organizations 决定注册后落到哪个组织
    const data = await apiFetch<MeResponse>('/auth/register', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    queryClient.setQueryData(['me'], data);
    return data;
  };

  const logout = async () => {
    try {
      await apiFetch('/auth/logout', { method: 'POST' });
    } finally {
      // 步骤 3c：即使登出请求失败也要清本地态，否则用户会卡在「已点退出但仍显示登录」的状态
      queryClient.setQueryData(['me'], null);
      // 顺带丢掉所有非 ['me'] 的业务缓存（组织成员、文档、消息等），避免换账号后看到上一个人的数据
      queryClient.removeQueries({
        predicate: (query) => query.queryKey[0] !== 'me',
      });
    }
  };

  // 供 JoinPage 这类「接受了邀请、组织列表变了」的场景手动回源
  const refreshMe = async () => {
    await query.refetch();
  };

  // 步骤 4：四个动作函数不进依赖数组——它们只捕获稳定的 queryClient / query 方法，不读 props 或 state
  const value = useMemo<AuthContextValue>(
    () => ({
      user: query.data?.user ?? null,
      organizations: query.data?.organizations ?? [],
      isLoading: query.isLoading,
      error: query.error ?? null,
      login,
      register,
      logout,
      refreshMe,
    }),
    [query.data, query.isLoading, query.error],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * 读取登录态的钩子。
 * 说明：不在 AuthProvider 子树内调用会抛错（context 默认值是 null），所以它是「必须包在 Provider 里」
 * 的硬约束，而不是返回空对象让调用方自己兜底。
 */
export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
