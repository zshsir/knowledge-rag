/**
 * 一个极小的 Cookie 头解析器，只服务一个场景：WebSocket 握手期读出会话令牌。
 *
 * 为什么不能用现成的 cookie-parser：它是 Express 中间件，把解析结果挂在 request.cookies 上，
 * 而 socket.io 的握手不经过 Express 请求管道（见 realtime.gateway 的文件头），
 * 那里只有一串原始的 Cookie 请求头字符串。为了这一个键引入整套中间件不值得，所以手写四行。
 *
 * 解析步骤：
 * 1. 头不存在 → 返回空对象（调用方拿不到令牌就按未登录处理）
 * 2. 按 ';' 切成一段段
 * 3. 每段取第一个 '=' 的位置切成键与值——用 indexOf 而不是 split('=')，
 *    因为 Cookie 的值本身可以含 '='（base64 结尾的填充），split 会把值切碎
 * 4. 键与值都 trim（浏览器习惯写成 "; key=value"），没有 '=' 的段直接丢弃
 * 5. 值做 decodeURIComponent 还原（写入时是编码过的），键为空也丢弃
 *
 * 明确的边界（不要把它当成完整的 Cookie 语义实现）：
 * - 不看 Domain / Path / HttpOnly / Secure / Expires，那些是浏览器与服务端 Set-Cookie 的事
 * - 不去重：同名键出现多次时后出现的覆盖先出现的（浏览器本身不会在同一请求里重复发同名 Cookie）
 * - 遇到非法百分号转义（例如值为 "100%"）时 decodeURIComponent 会抛 URIError，
 *   本函数不做兜底——调用方（握手中间件）整个包在 try 里，效果就是这次连接被判 unauthorized
 * - 不校验解出来的令牌，只负责把字符串从头上摘下来
 */
export function parseCookieHeader(header?: string): Record<string, string> {
  if (!header) return {};
  const result: Record<string, string> = {};
  for (const part of header.split(';')) {
    // 步骤 3：只按第一个 '=' 切，保住值里的 '='
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    // 步骤 5：空键丢弃，值统一解码一次
    if (key) result[key] = decodeURIComponent(value);
  }
  return result;
}
