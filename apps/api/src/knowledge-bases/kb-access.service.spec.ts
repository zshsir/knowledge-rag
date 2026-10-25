/**
 * KbAccessService.resolve 单测：守「有效权限阶梯」这条权限模型的判定顺序
 * （0a 库归属 → 0b 组织成员 → 1 owner/admin 穿透 → 2 创建者 → 3 显式授权 → 4 org 模式继承 viewer → 5 null）。
 * 顺序本身就是契约：改动任一步的先后，这里对应用例应变红（例如把 4 挪到 3 之前，restricted 库的
 * 显式授权用例与 org 库的用例会同时失守）。
 * 边界：只测 resolve 的返回值，不测 require 的 404/403 分界、也不测 getKbOrThrow
 *      （HTTP 层的 403/404 由 knowledge-bases / organizations 的 e2e 覆盖，但那里多数经
 *      KbPermissionGuard 走 resolve，require 自身的两条出口在本文件没有用例）；
 *      SQL 写法在 KbAccessRepository，这里用假 repo 把三次取数变成可控返回值，绝不连库——
 *      租户条件是否写对不是本文件能保证的。
 * 已知缺口：判定 0a（kbId 属于别的组织 → getKb 返回空 → null）没有用例，假 repo 支持传 kb
 *      但本文件没有一条传空；若哪天 repository 里的 orgId 租户条件被去掉，这里测不出来。
 */
import { KbAccessService } from './kb-access.service';
import { KbRow } from '../database/repositories/kb-access.repository';

// 默认知识库行：org 公开模式、创建者是 'creator'（下面的用例用 'u' 就代表「非创建者的普通成员」）
const kb: KbRow = {
  id: 'kb',
  orgId: 'org',
  name: 'KB',
  description: '',
  accessMode: 'org',
  createdBy: 'creator',
  createdAt: '',
  updatedAt: '',
};

/**
 * 造一个只实现三次取数的假 repo，对应 resolve 里的 getKb / getOrgRole / getMemberPermission。
 * 默认值是「org 成员 + org 模式库 + 无显式授权」，即最低阶梯；overrides 只改要考察的那一格，
 * 这样每条用例的判定来源唯一，不会同时命中两条规则。
 * 'kb' in overrides 的写法是为了能显式传 kb: undefined（模拟库查不到），同时不影响默认分支。
 */
function service(
  overrides: {
    orgRole?: 'owner' | 'admin' | 'member' | null;
    kb?: KbRow;
    explicit?: 'viewer' | 'editor' | 'manager' | null;
  } = {},
) {
  const repo = {
    getOrgRole: jest
      .fn()
      .mockResolvedValue(overrides.orgRole === undefined ? 'member' : overrides.orgRole),
    getKb: jest.fn().mockResolvedValue('kb' in overrides ? overrides.kb : kb),
    getMemberPermission: jest.fn().mockResolvedValue(overrides.explicit ?? null),
  };
  return new KbAccessService(repo as never);
}

describe('KbAccessService', () => {
  // 回归点：判定 1（管理员穿透）排在创建者与 accessMode 之前——组织 owner/admin 恒为 manager。
  // admin 那半特意配 restricted 库：若哪天 accessMode 检查被提到穿透之前，管理员会被降级成 null
  it('gives owner and admin manager regardless of access mode', async () => {
    await expect(service({ orgRole: 'owner' }).resolve('org', 'kb', 'u')).resolves.toBe('manager');
    await expect(
      service({ orgRole: 'admin', kb: { ...kb, accessMode: 'restricted' } }).resolve('org', 'kb', 'u'),
    ).resolves.toBe('manager');
  });

  // 回归点：判定 4（组织公开继承 viewer）——普通成员没被单独授权也至少能读
  it('gives org members viewer on org-wide KBs', async () => {
    await expect(service().resolve('org', 'kb', 'u')).resolves.toBe('viewer');
  });

  // 回归点：判定 2（创建者天生 manager）——库切成 restricted、也没有授权行时创建者仍可管理
  it('gives creator manager on restricted KBs', async () => {
    await expect(
      service({
        kb: { ...kb, accessMode: 'restricted' },
      }).resolve('org', 'kb', 'creator'),
    ).resolves.toBe('manager');
  });

  // 回归点：判定 3 排在判定 4 之前——显式授权不被「库是 org 模式」的继承覆盖，能升到 editor
  it('uses explicit permission on restricted KBs', async () => {
    await expect(
      service({
        kb: { ...kb, accessMode: 'restricted' },
        explicit: 'editor',
      }).resolve('org', 'kb', 'u'),
    ).resolves.toBe('editor');
  });

  // 回归点：判定 0b（移出组织的人没有任何继承权限，创建者身份也救不了他）
  // 与判定 5（restricted 库里没被点名的人拿不到权限）；两处都返回 null 而不抛错，
  // 对外语义留给调用方决定——require 把任何 null 统一变成 404（kb-access.service.ts:105）
  it('denies non-members and unlisted members on restricted KBs', async () => {
    await expect(service({ orgRole: null }).resolve('org', 'kb', 'u')).resolves.toBeNull();
    await expect(
      service({ kb: { ...kb, accessMode: 'restricted' } }).resolve('org', 'kb', 'u'),
    ).resolves.toBeNull();
  });
});
