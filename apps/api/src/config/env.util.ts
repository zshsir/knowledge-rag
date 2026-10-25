/**
 * 安全摘要工具：给令牌类字符串算一个不可逆的哈希。
 *
 * 职责边界：
 * - 只做 SHA-256，不做加盐、不做截断，也不管令牌怎么生成、怎么过期，那些由各自的 service 负责
 * - 口令不能用它，必须走 bcrypt（见 auth/password.service.ts）
 */
import { createHash } from 'node:crypto';

/**
 * 算令牌的 SHA-256 摘要，用于「库里只存摘要、原文只在链接里出现一次」。
 *
 * 为什么可以不加盐：会话令牌与邀请令牌都是高熵随机串，不存在口令那种字典猜测风险；
 * 加盐反而会让按 token_hash 等值查询变成不可能——验证时必须现算再等值比对。
 * 目标是：会话令牌与邀请令牌都只存 SHA-256 摘要，库被拖走也无法还原可用令牌。
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
