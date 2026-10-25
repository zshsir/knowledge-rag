/**
 * 组织 / 成员 / 邀请 e2e：守三件事——一次性邀请令牌、组织角色门槛、跨组织不可见。
 * 这三条都是「改坏了不会立刻报错、只会悄悄泄露权限」的那类契约，所以只能靠 HTTP 层的
 * 状态码来钉，单测里那些假仓储是测不出来的。
 * 契约与出处：
 * - 邀请令牌一次性：库里只存 token_hash 摘要（原始令牌只在签发那一次出现），
 *   accepted_at 非空即作废（invites.service.ts:214-219 publicInfo 的 valid 是「没用过且没过期」算出来的，
 *   不是存的字段）；消费路径有两条——带 inviteToken 注册（auth.service.ts:105-149）
 *   与已登录用户 accept（invites.service.ts:250-325），两条都用 SELECT ... FOR UPDATE 防双花
 * - 角色门槛表在 members.service.ts:28-41 的注释里，逐条对得上代码：
 *   改角色只有 owner 能动手（updateRole:72），member 签邀请一律 403、admin 签 admin 也 403
 *   （invites.service.ts:80-86），owner 永远造不出第二个 owner
 * - 跨组织：OrgMemberGuard 之后所有查询都带 org_id，所以别人的组织直接 404
 * 边界：不测知识库级权限（那是 knowledge-bases.e2e-spec.ts），也不测会话失效本身（auth e2e）。
 * 数据假设：真库、无 truncate；每个 owner 一个新组织，用例之间靠组织 id 天然隔离，不依赖执行顺序。
 * 已知未覆盖：邀请过期（410）与「撤销邀请后 accept 得 404」两条分支本文件没有用例，
 * 因为签发时没有办法把 expires_at 改到过去（INVITE_TTL_DAYS 是写死的常量，invites.service.ts:51）。
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/create-app';

describe('organizations', () => {
  let app: INestApplication;

  /** 每个用例一个新组织；email 带时间戳只是为了躲开库里历史行的 lower(email) 唯一索引 */
  const registerOwner = async (suffix: string) => {
    const agent = request.agent(app.getHttpServer());
    const email = `owner-${suffix}-${Date.now()}@test.local`;
    const res = await agent
      .post('/api/auth/register')
      .send({ name: 'Owner', email, password: 'password123', orgName: `Org ${suffix}` })
      .expect(201);
    return { agent, email, user: res.body.user, orgId: res.body.organizations[0].id };
  };

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());

  // 回归点：邀请→注册→作废→提权→提权上限，五步一条链。
  // 逐步说防的是什么：
  // 1) 注册者拿到的角色是邀请里预定的 member，不是他自己填的（auth.service.ts:127-131 沿用 invite.role）
  // 2) 消费过的链接在确认页要显示成 valid:false，但状态码仍是 200（publicInfo 刻意不抛错，
  //    让前端能先展示「你将加入 X」再就地告知失效）
  // 3) member 改自己的角色 403：拦点是 updateRole 第一行的「只有 owner 能改」，
  //    这里的 actor 与 target 是同一个人，所以命中的是资格闸而不是「不能改 owner」那条
  // 4) owner 提 admin 200
  // 5) admin 造不出第二个 admin（403），但能签 member 邀请（201）——提权与拉人是两回事
  // 名字里的 "enforces roles" 指的是这后两条，owner 被降级、admin 移除 admin 之类的分支本用例没测
  it('invites a member, enforces roles and allows promotion', async () => {
    const owner = await registerOwner('a');
    const invite = await owner.agent
      .post(`/api/orgs/${owner.orgId}/invites`)
      .send({ role: 'member' })
      .expect(201);

    const memberAgent = request.agent(app.getHttpServer());
    const memberRes = await memberAgent
      .post('/api/auth/register')
      .send({
        name: 'Member',
        email: `member-${Date.now()}@test.local`,
        password: 'password123',
        inviteToken: invite.body.token,
      })
      .expect(201);
    expect(memberRes.body.organizations[0].role).toBe('member');
    const memberId = memberRes.body.user.id;

    await request(app.getHttpServer())
      .get(`/api/invites/${invite.body.token}`)
      .expect(200)
      .expect((res) => {
        expect(res.body.valid).toBe(false);
      });

    await memberAgent
      .patch(`/api/orgs/${owner.orgId}/members/${memberId}`)
      .send({ role: 'admin' })
      .expect(403);

    await owner.agent
      .patch(`/api/orgs/${owner.orgId}/members/${memberId}`)
      .send({ role: 'admin' })
      .expect(200);

    await memberAgent
      .post(`/api/orgs/${owner.orgId}/invites`)
      .send({ role: 'admin' })
      .expect(403);

    await memberAgent
      .post(`/api/orgs/${owner.orgId}/invites`)
      .send({ role: 'member' })
      .expect(201);
  });

  // 回归点两件事，缺一件就是真事故：
  // 1) 圈外人凭别人的 orgId 连成员列表都拿不到（404 而不是空列表，避免「这个组织存在且有人」外泄）
  // 2) owner 移除 member 之后，被移除者【自己的会话仍然有效】，但 /auth/me 的组织列表里不再有那个组织
  //    ——这正是 remove 刻意不删 sessions 行的设计（members.service.ts:110-115 的说明）：
  //    会话只回答「他登录过」，能不能进门每次现判。所以断言写的是组织列表而不是 401
  // 没在这里断言的：remove 事务里连带删掉的 knowledge_base_members 授权行与 conversations 历史
  // （members.service.ts:145-166）；事务提交后逐库 emit 的回收事件（:169-175）也没有任何 e2e
  // 走这条 HTTP 路径观察——realtime.e2e-spec.ts 是直接调 AccessEventsService.emit 测网关那一侧的
  it('blocks cross-organization access and removes members', async () => {
    const owner = await registerOwner('b');
    const other = await registerOwner('c');
    const invite = await owner.agent
      .post(`/api/orgs/${owner.orgId}/invites`)
      .send({ role: 'member' })
      .expect(201);
    const memberAgent = request.agent(app.getHttpServer());
    const memberRes = await memberAgent
      .post('/api/auth/register')
      .send({
        name: 'Member',
        email: `member-cross-${Date.now()}@test.local`,
        password: 'password123',
        inviteToken: invite.body.token,
      })
      .expect(201);

    await other.agent.get(`/api/orgs/${owner.orgId}/members`).expect(404);

    await owner.agent
      .delete(`/api/orgs/${owner.orgId}/members/${memberRes.body.user.id}`)
      .expect(200);

    await memberAgent
      .get('/api/auth/me')
      .expect(200)
      .expect((res) => {
        expect(res.body.organizations.map((o: { id: string }) => o.id)).not.toContain(
          owner.orgId,
        );
      });
  });

  // 回归点：邀请的第二条消费通道——已登录用户点链接补加入（accept，不是注册分支）。
  // 断言只比了返回的组织 id 等于签发方那个组织，即「orgId 来自邀请行而不是请求参数」这条防呆
  // （invites.service.ts:280-294：角色与组织都照抄邀请，请求方无从指定）。
  // 「同一 token 再 accept 一次要 409」这条双花防护本用例没有测（全仓的 spec/e2e 里没有任何地方
  // 断言过 invites.service.ts:275 那句「邀请已被使用」），FOR UPDATE 那把锁目前只靠代码审查守着
  it('accepts an invite as an existing user', async () => {
    const owner = await registerOwner('d');
    const invite = await owner.agent
      .post(`/api/orgs/${owner.orgId}/invites`)
      .send({ role: 'member' })
      .expect(201);

    const user = await registerOwner('e');
    await user.agent
      .post(`/api/invites/${invite.body.token}/accept`)
      .expect(200)
      .expect((res) => {
        expect(res.body.organization.id).toBe(owner.orgId);
      });
  });
});
