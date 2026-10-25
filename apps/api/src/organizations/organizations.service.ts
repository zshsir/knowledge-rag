/**
 * 组织本体的用例服务：建组织、改组织名。
 *
 * 职责与边界：
 * - 只碰 organizations 表加一条 owner 成员关系；成员管理在 members.service.ts，
 *   邀请在 invites.service.ts，知识库在 knowledge-bases 模块
 * - 只有写操作。「我加入了哪些组织」不在这里查：那个查询由 OrganizationsRepository.listForUser
 *   承担，调用方全在 auth 侧（登录、注册、GET /auth/me 三处返回体都带组织列表）
 * - 不校验「一个人能建几个组织」，也不看注册开关——POST /orgs 的前提是已登录，登录后想开几个开几个
 * - 删除组织没有入口：organizations 表对 knowledge_bases/memberships/invites 是级联父表，
 *   真要删会带走整个租户的数据，所以本系统刻意不提供
 */
import { ForbiddenException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { OrgSummary } from '../common/types';
import { DatabaseService } from '../database/database.service';
import { OrganizationsRepository } from '../database/repositories/organizations.repository';
import { CurrentMembershipValue } from '../common/decorators/current-membership.decorator';

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly organizations: OrganizationsRepository,
  ) {}

  /**
   * 新建组织，创建人自动成为 owner。步骤（一个事务，两条 INSERT 同生同死）：
   * 1. 先在应用层 randomUUID 生成 orgId：第二条 INSERT 要引用它，靠数据库默认值就取不到
   *    （knowledge_bases 的插入用的是同一套做法）
   * 2. INSERT organizations：name 先 trim（长度 1–60 由 CreateOrgDto 把关），created_by 记发起人
   * 3. INSERT memberships：角色是 SQL 里写死的 'owner'，不接受任何入参——建组织的人必然是所有者。
   *    产生 owner 的入口一共两处：本方法，以及开放注册时 auth.service.register 的自建组织分支，
   *    两处都是硬编码 owner；改角色/邀请都造不出 owner
   * 4. 提交后直接用手上的三个值拼 OrgSummary 返回，不回查数据库：这三行刚刚才写进去
   * 边界：本方法不建会话、不写 Cookie，也不管这个人是否已有别的组织（多组织共存是常态）
   */
  async create(userId: string, name: string): Promise<OrgSummary> {
    const orgId = randomUUID();
    await this.db.withTransaction(async (client) => {
      await client.query(
        'INSERT INTO organizations (id, name, created_by) VALUES ($1, $2, $3)',
        [orgId, name.trim(), userId],
      );
      await client.query(
        `INSERT INTO memberships (id, org_id, user_id, role)
         VALUES ($1, $2, $3, 'owner')`,
        [randomUUID(), orgId, userId],
      );
    });
    return { id: orgId, name: name.trim(), role: 'owner' };
  }

  /**
   * 重命名组织。步骤：
   * 1. 门槛是 owner 专属：admin 也 403。这与成员/邀请类接口不同——那些放开到 admin，
   *    组织名被视为租户身份，改它的权利留在 owner 手里
   * 2. 交仓储层按 org_id 单行 UPDATE 并刷新 updated_at；name 同样 trim 一次
   * membership 来自 OrgMemberGuard（已确认这个人属于 orgId），所以这里不需要再查一次成员关系；
   * orgId 与 membership.role 都取自守卫挂上的请求上下文，不接受请求方自报的组织身份。
   */
  async rename(
    orgId: string,
    membership: CurrentMembershipValue,
    name: string,
  ): Promise<{ ok: true }> {
    if (membership.role !== 'owner') {
      throw new ForbiddenException('仅所有者可以修改组织名称');
    }
    await this.organizations.rename(orgId, name.trim());
    return { ok: true };
  }
}
