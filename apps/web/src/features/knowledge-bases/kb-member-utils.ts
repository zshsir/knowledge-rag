/**
 * 成员候选过滤：从组织成员里剔除「已经能访问这个知识库」的人，只留下还能被显式授权的人。
 *
 * 职责与边界：
 * - 纯函数：不请求、不改入参、不排序，输出顺序沿用 orgMembers 的原顺序（调用方决定数据来源）
 * - 只按 userId 判定，不看姓名/邮箱——同一个账号的唯一标识是 id，同名同邮箱的情况不该被顺手合并
 * - 不判断「谁有资格授权」（那是服务端的事）；这里只解决下拉里不该出现谁的展示问题
 *
 * 算法：
 * 1. 把显式授权（members）与继承的 manager（inherited：组织 owner/admin + 库创建者）的 userId
 *    合成一个集合
 * 2. 按集合过滤组织成员。已在集合里的人不再作为候选：对继承者后端会 400（他们本来就是 manager），
 *    对已授权的成员则应该去列表行里改权限，而不是再从「添加」入口写一次
 */
import type { KbMember, OrgMember } from '../../lib/types';

export function computeAddableCandidates(
  orgMembers: OrgMember[],
  members: KbMember[],
  inherited: KbMember[],
): OrgMember[] {
  const existingIds = new Set([
    ...members.map((member) => member.userId),
    ...inherited.map((member) => member.userId),
  ]);
  return orgMembers.filter((member) => !existingIds.has(member.id));
}
