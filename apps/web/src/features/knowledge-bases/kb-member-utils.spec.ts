/**
 * computeAddableCandidates 的回归测试：钉住「知识库『添加成员』下拉里不该出现谁」。
 * 契约只有一条：显式授权（members）与继承 manager（inherited：组织 owner/admin + 库创建者）
 * 这两个集合里的人都要被剔掉，剩下的人才还能被再授权一次
 * （kb-member-utils.ts:9-14 的算法说明；后端对这两类人分别会 400，见 kb-members.service.ts:137-143）。
 * 为什么值得单独测：这个函数只做「并集 + 过滤」两步，写错的方式很安静——
 * 漏看 inherited 会让下拉里出现创建者，选了才被后端 400；漏看 members 则会出现重复授权入口。
 * 两种都表现为「界面给了个点了没用的选项」，没有异常也没有红日志，只能靠测试兜。
 * 夹具说明：orgMember/kbMember 两个工厂只填判定要用的字段（id / userId），
 * 姓名与邮箱是类型要求，不参与算法（判定是拿组织成员的 id 去比对由 members/inherited 两处的 userId
 * 汇成的 Set，见 kb-member-utils.ts:22-26），所以这里的 '成员a' 之类没有含义。
 * 环境说明：vitest 用 environment: 'node'（apps/web/vitest.config.ts），纯函数直接调即可。
 * 顺序契约：输出沿用 orgMembers 的入参顺序，但下面没有任何一条用例断言过顺序
 * （每步结果都是 1 个元素或空数组），所以有人改成 sort 也不会红。
 * 用例名与断言不完全对齐的一处：最后一条名字是 "already granted"（已授权），
 * 实际传给 members 的是空数组、排除依据来自第三个参数 inherited，也就是它测的是继承那一侧，
 * 与第三条 'excludes inherited members' 走的是同一条件；只是入参形状不同，不改名先记下。
 */
import { describe, expect, it } from 'vitest';
import { computeAddableCandidates } from './kb-member-utils';
import type { KbMember, OrgMember } from '../../lib/types';

/** 组织成员：id 是过滤用的唯一键，其余字段只为满足类型 */
function orgMember(id: string): OrgMember {
  return { id, name: `成员${id}`, email: `${id}@example.com`, role: 'member', joinedAt: '2026-10-23T00:00:00Z' };
}

/** 知识库侧的一行（显式授权或继承 manager 都用它）：只有 userId 参与判定 */
function kbMember(userId: string): KbMember {
  return { userId, name: `成员${userId}`, email: `${userId}@example.com`, permission: 'viewer' };
}

describe('computeAddableCandidates', () => {
  // 边界：三个入参全空时不能凭空造出候选（也不该抛错）
  it('returns empty when the org has no members', () => {
    expect(computeAddableCandidates([], [], [])).toEqual([]);
  });

  // 回归点：漏掉第一个入参（显式授权集合）时这条会红——已经能访问库的人不该再出现在「添加」里
  it('excludes explicitly granted members', () => {
    const result = computeAddableCandidates(
      [orgMember('a'), orgMember('b')],
      [kbMember('a')],
      [],
    );
    expect(result.map((m) => m.id)).toEqual(['b']);
  });

  // 回归点：漏掉第二个入参（继承集合）时这条会红——创建者/组织管理员本来就是 manager，
  // 选他们去授权只会拿到后端的 400
  it('excludes inherited members (creator/org admin)', () => {
    const result = computeAddableCandidates(
      [orgMember('a'), orgMember('b')],
      [],
      [kbMember('a')],
    );
    expect(result.map((m) => m.id)).toEqual(['b']);
  });

  // 回归点：两个集合同时给、且里面有重复 id（'a' 在显式与继承里各出现一次，继承里还有 'b'）。
  // 验的是「两个入参都要参与判定」加上「同一个 id 出现两次不会出问题」——并集用 Set，天然幂等
  it('excludes ids present in both explicit and inherited lists', () => {
    const result = computeAddableCandidates(
      [orgMember('a'), orgMember('b'), orgMember('c')],
      [kbMember('a')],
      [kbMember('b'), kbMember('a')],
    );
    expect(result.map((m) => m.id)).toEqual(['c']);
  });

  // 全排除的终态：候选列表应当是空数组而不是 undefined/原列表，下拉靠它决定「没有可加的人」的提示
  // （注意名字说的 "already granted" 与实际入参不完全对应，见文件头那条说明）
  it('returns an empty list when every org member is already granted', () => {
    const result = computeAddableCandidates(
      [orgMember('a')],
      [],
      [kbMember('a')],
    );
    expect(result).toEqual([]);
  });
});
