/**
 * 前端唯一的 HTTP 出口：把 fetch 包成「一定带会话 Cookie、失败一定抛同一种错」的一层。
 *
 * 请求约定（调用方只需要记住这四条）：
 * 1. 一律带 credentials:'include'，Session 靠 httpOnly Cookie（kr_session），前端拿不到令牌：
 *    grep apps/web/src 只有本文件出现 Content-Type，没有任何手写 Authorization 头，
 *    也没有 localStorage/sessionStorage 存凭证
 * 2. 非 2xx 统一抛 ApiError（带 status 与后端 message），调用方只在 UI 层决定怎么展示
 * 3. 401 时派发全局 auth:unauthorized 事件，由 AuthProvider 统一把 ['me'] 缓存置空，
 *    跳登录这一步实际是置空之后 ProtectedRoute 看到 user 为 null 才做的
 *    （features/auth/AuthProvider.tsx:48-54 是唯一监听点，app/ProtectedRoute.tsx:10-13 负责跳转），
 *    所以页面不用各写一遍
 * 4. FormData 请求不能手设 Content-Type，否则浏览器不生成 boundary（上传乱码的诱因之一）；
 *    本模块的做法是「有 body 且不是 FormData 且调用方没自己声明 Content-Type」才补 application/json，
 *    上传调用方（features/documents/DocumentsPage.tsx:119-128）只传 method + body
 *
 * 边界：只管传输与错误归一化——不缓存、不重试、不认识 TanStack Query，也不做任何权限判断
 * （403 照样抛 ApiError，文案交给 UI）。除上面第 3 条那个全局事件外没有别的副作用。
 * 调用方是 features/** 的各页面与 AuthProvider。
 */
// 基址默认 /api：开发时由 vite.config.ts:10 的代理转到后端，生产走同源反代；
// 只有前后端不同源部署时才需要设 VITE_API_BASE
const API_BASE = import.meta.env.VITE_API_BASE ?? '/api';

/**
 * 非 2xx 的统一错误类型。
 * status 原样保留后端状态码，调用方靠它分流「没登录（401）/没权限（403）/不存在（404）/参数错（400）」；
 * message 已是后端给的中文可读文案，UI 层通常直接 toast 出来，不需要再做映射。
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * 发一次带会话的请求，成功按 T 返回解析好的 JSON，失败抛 ApiError。
 * 步骤：
 * 1. 合并调用方 headers，按约定 4 决定是否补 JSON 头（FormData / 已自带 Content-Type 都不补）
 * 2. 拼 API_BASE + path 发 fetch，强制 credentials:'include'；path 传相对路径，不要带 /api 前缀
 * 3. 401 先派发 auth:unauthorized 再照常抛错——事件只是通知，不改变本次 Promise 的结果，
 *    所以 /auth/me 自己那次 401（冷启动未登录）也会走到这里，被 AuthProvider 的 queryFn 转成 null
 * 4. 非 2xx 组装可读 message：Nest 的异常体里 message 可能是字符串，也可能是 class-validator
 *    的校验错误数组，数组用「；」拼成一句；响应体压根不是 JSON（反代 502 的 HTML）时保留兜底文案
 * 5. 204 直接返回 undefined，其余按 JSON 解析后返回
 * 泛型 T 由调用方自己保证与后端响应体一致（一致性靠 lib/types.ts 那组接口约束，运行时不校验）
 */
export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  // 步骤 1：约定 4——上传走 FormData，这里刻意不碰 Content-Type，boundary 交给浏览器生成
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
    credentials: 'include',
  });

  // 步骤 3：全局广播「会话已失效」，由 AuthProvider 清缓存、ProtectedRoute 完成跳转
  if (response.status === 401) {
    window.dispatchEvent(new CustomEvent('auth:unauthorized'));
  }

  if (!response.ok) {
    let message = `请求失败 (${response.status})`;
    try {
      const data = (await response.json()) as { message?: string | string[] };
      if (Array.isArray(data.message)) message = data.message.join('；');
      else if (data.message) message = data.message;
    } catch {
      // 步骤 4：响应体不是 JSON 时不动 message，保留上面那句带状态码的兜底文案
    }
    throw new ApiError(response.status, message);
  }

  // 步骤 5：空响应体没有 JSON 可解析，返回 undefined 而不是让 response.json() 抛解析错
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/**
 * 拼「下载原文件」的 URL，给 <a href> 用（DocumentsPage.tsx:281-290 带 target="_blank"）。
 * 刻意不走 apiFetch：下载响应是二进制，fetch 完还得自己拼 Blob 才能触发另存为，
 * 而浏览器直接导航时照样会带上同源 Cookie，后端 OrgMemberGuard + 服务层 viewer 判定照常生效。
 */
export function downloadUrl(orgId: string, documentId: string): string {
  return `${API_BASE}/orgs/${orgId}/documents/${documentId}/download`;
}

/**
 * 上传控件的 accept 白名单，与后端 apps/api/src/documents/document-validation.ts:29-36
 * 的扩展名 ALLOWED 表是同一组四种（txt/md/pdf/docx）。
 * 它只影响文件选择器默认能选到什么，拦不住任何东西：真正的校验在后端 document-validation.ts
 * 的三层判断（扩展名 → 客户端声明的 mimetype → PDF/DOCX 的 magic bytes）。
 */
export const UPLOAD_ACCEPT = '.txt,.md,.pdf,.docx';
