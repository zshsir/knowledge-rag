/**
 * 知识库可见性与 ACL e2e：把「权限阶梯」真正走到 HTTP 状态码与列表徽标上的那套用例。
 * 阶梯本体在 kb-access.service.ts:41-51（0a 库不在本组织→null、0b 非成员→null、
 * 1 owner/admin→manager、2 创建者→manager、3 显式授权行→其值、4 org 模式→viewer、5 否则 null），
 * 列表侧还有一份【同规则的第二实现】：SQL 可见性四条件在 knowledge-bases.repository.ts:99-102，
 * 内存里的等级推导在 knowledge-bases.service.ts:38-48。
 * 所以本文件的意义不只是测 resolve，而是「两份实现今天还一致」这件事唯一的证据——
 * 改了其中一份而没改另一份，就会出现「列表里看得见但请求 404」或反之，只有 e2e 能同时看到两端。
 * 命中情况要说清（不是七条全测）：本文件验到的是判定 1（owner/admin）、3（显式授权）、4（org 继承）、
 * 5（restricted 无授权 → 列表里消失）；0a 与 0b 都没有用例——非成员一律在 OrgMemberGuard:41 就被 404 挡下，
 * 根本走不到 resolve（详见下面 'hides KBs from other organizations' 那条的说明）；
 * 判定 2「创建者但只是普通成员」没有用例——这里的创建者同时是 owner，判定 1 先命中，两条规则给同一个值。
 * 对外口径同样是契约：null→404（不承认库存在，kb-access.service.ts:105）、可达但等级不够→403（:107）。
 * 夹具说明：owner / member / outsider 全部走真实注册与邀请链路（同 documents.e2e-spec.ts），
 * 目的是拿到合法会话 Cookie 去过守卫；没有任何一行权限数据是手插的。
 * 数据假设：真库、无 truncate，每个用例新组织新库，用例之间不依赖执行顺序；
 * 但【同一个用例内部】的步骤是强顺序的（先授予→再查列表→再改权限→再撤），换序即失真。
 * 未覆盖（别把名字当成覆盖面）：
 * - 判定 0a（同组织成员拿【别的组织】的 kbId）这里没有用例：第三条 'hides KBs from other
 *   organizations' 的请求者连组织成员都不是，404 由 OrgMemberGuard 先给出，走不到 resolve
 * - 被单独授权成 manager 的普通成员【不能删库】这条二次收紧（knowledge-bases.service.ts:228-232）无用例
 * - org→restricted 切换时发出的回收事件（reason:'kb-restricted'）本文件不订阅 socket，因此没断言
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/create-app';

type TestAgent = ReturnType<typeof request.agent>;

describe('knowledge bases and ACL', () => {
  let app: INestApplication;

  /** 一个用例一个新组织 + 一个 owner；email 同时留给「按邮箱加成员」那条用例当已知地址 */
  const registerOwner = async (suffix: string) => {
    const agent = request.agent(app.getHttpServer());
    const email = `kb-owner-${suffix}-${Date.now()}@test.local`;
    const res = await agent
      .post('/api/auth/register')
      .send({ name: 'Owner', email, password: 'password123', orgName: `KB Org ${suffix}` })
      .expect(201);
    return { agent, orgId: res.body.organizations[0].id, email, userId: res.body.user.id };
  };

  /**
   * 组织里的普通 member：同样靠真实邀请链注册。
   * 他【没有】任何 knowledge_base_members 行，所以对 org 模式的库是判定 4 给的 viewer、
   * 对 restricted 的库是判定 5 的 null——这两套结果正是下面第一条用例要对照的东西
   */
  const joinMember = async (owner: { agent: TestAgent; orgId: string }, suffix: string) => {
    const invite = await owner.agent
      .post(`/api/orgs/${owner.orgId}/invites`)
      .send({ role: 'member' })
      .expect(201);
    const agent = request.agent(app.getHttpServer());
    const res = await agent
      .post('/api/auth/register')
      .send({
        name: 'Member',
        email: `kb-member-${suffix}-${Date.now()}@test.local`,
        password: 'password123',
        inviteToken: invite.body.token,
      })
      .expect(201);
    return { agent, userId: res.body.user.id };
  };

  /** 两种模式各测什么：'org' 让全组织成员靠判定 4 继承 viewer，'restricted' 则只认显式授权行 */
  const createKb = async (
    agent: TestAgent,
    orgId: string,
    name: string,
    accessMode: 'org' | 'restricted' = 'org',
  ) =>
    agent
      .post(`/api/orgs/${orgId}/knowledge-bases`)
      .send({ name, accessMode })
      .expect(201);

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());

  // 阶梯判定 3/4/5 与「列表可见性 SQL」的一次对照，顺序不能打乱：
  // 1) member 看得见 org 库（判定 4 继承 viewer）、看不见 restricted 库（判定 5 → null，
  //    同时列表 SQL 的四个可见条件也都不成立）
  // 2) 改名要 manager：他只有 viewer → 403（这拦的是「可达但等级不够」，所以不是 404）
  // 3) 给一行显式 viewer 授权后，restricted 库【立刻】出现在他列表里且 effectivePermission='viewer'：
  //    这一条同时钉住「授权不缓存、每次现查」和「判定 3 排在判定 4 之前」
  // 4) viewer 读成员名单 403（成员管理路由门槛是 manager）
  // 5) 把授权改成 editor，列表里的徽标跟着变 editor —— 防的是「改了表但列表仍按旧规则推导」
  // 6) 撤掉授权行后他又从列表里消失（restricted 模式下没有别的继承通道了）
  // 名字里的 "enforces manager permissions" 指第 2 与第 4 步，都是 403 分支
  it('creates KBs, hides restricted KBs and enforces manager permissions', async () => {
    const owner = await registerOwner('a');
    const orgKb = await createKb(owner.agent, owner.orgId, 'Handbook', 'org');
    const restrictedKb = await createKb(owner.agent, owner.orgId, 'Secret', 'restricted');

    const member = await joinMember(owner, 'a');

    const listForMember = await member.agent
      .get(`/api/orgs/${owner.orgId}/knowledge-bases`)
      .expect(200);
    const ids = listForMember.body.map((kb: { id: string }) => kb.id);
    expect(ids).toContain(orgKb.body.id);
    expect(ids).not.toContain(restrictedKb.body.id);

    await member.agent
      .patch(`/api/orgs/${owner.orgId}/knowledge-bases/${orgKb.body.id}`)
      .send({ name: 'Hacked' })
      .expect(403);

    await owner.agent
      .post(`/api/orgs/${owner.orgId}/knowledge-bases/${restrictedKb.body.id}/members`)
      .send({ userId: member.userId, permission: 'viewer' })
      .expect(201);

    const listAfterGrant = await member.agent
      .get(`/api/orgs/${owner.orgId}/knowledge-bases`)
      .expect(200);
    const granted = listAfterGrant.body.find((kb: { id: string }) => kb.id === restrictedKb.body.id);
    expect(granted.effectivePermission).toBe('viewer');

    await member.agent
      .get(`/api/orgs/${owner.orgId}/knowledge-bases/${restrictedKb.body.id}/members`)
      .expect(403);

    await owner.agent
      .patch(`/api/orgs/${owner.orgId}/knowledge-bases/${restrictedKb.body.id}/members/${member.userId}`)
      .send({ permission: 'editor' })
      .expect(200);

    const listAfterUpdate = await member.agent
      .get(`/api/orgs/${owner.orgId}/knowledge-bases`)
      .expect(200);
    expect(
      listAfterUpdate.body.find((kb: { id: string }) => kb.id === restrictedKb.body.id)
        .effectivePermission,
    ).toBe('editor');

    await owner.agent
      .delete(`/api/orgs/${owner.orgId}/knowledge-bases/${restrictedKb.body.id}/members/${member.userId}`)
      .expect(200);
    const listAfterRemove = await member.agent
      .get(`/api/orgs/${owner.orgId}/knowledge-bases`)
      .expect(200);
    expect(listAfterRemove.body.map((kb: { id: string }) => kb.id)).not.toContain(
      restrictedKb.body.id,
    );
  });

  // 回归点两半：
  // 1) PATCH accessMode 从 org 改成 restricted 后，原先靠判定 4 继承的普通成员立刻看不见这个库
  //    ——钉住「不缓存、每请求重判」，改完不需要等任何人刷新缓存
  // 2) 同一个人被提成组织 admin 后，同一个库又以 manager 出现在他列表里（判定 1 的穿透 +
  //    列表 SQL 的 $3 IN ('owner','admin') 条件），且徽标是 manager 不是 viewer
  // 顺序是有意义的：中间那次 PATCH 成员角色必须排在第二次列表之后，否则两半就分不开了。
  // 没在这里断言的：org→restricted 时服务层会先算受影响人群再 emit 回收事件
  // （knowledge-bases.service.ts:176-194），本文件不开 socket，事件那一半没有任何断言
  it('switches org-wide KB to restricted and gives admins full visibility', async () => {
    const owner = await registerOwner('b');
    const member = await joinMember(owner, 'b');
    const kb = await createKb(owner.agent, owner.orgId, 'Org KB', 'org');

    await owner.agent
      .patch(`/api/orgs/${owner.orgId}/knowledge-bases/${kb.body.id}`)
      .send({ accessMode: 'restricted' })
      .expect(200);

    let list = await member.agent
      .get(`/api/orgs/${owner.orgId}/knowledge-bases`)
      .expect(200);
    expect(list.body.map((item: { id: string }) => item.id)).not.toContain(kb.body.id);

    await owner.agent
      .patch(`/api/orgs/${owner.orgId}/members/${member.userId}`)
      .send({ role: 'admin' })
      .expect(200);

    list = await member.agent
      .get(`/api/orgs/${owner.orgId}/knowledge-bases`)
      .expect(200);
    const asAdmin = list.body.find((item: { id: string }) => item.id === kb.body.id);
    expect(asAdmin.effectivePermission).toBe('manager');
  });

  // 回归点：跨组织的库详情读不到，对外是 404（不是 403，不承认这个库存在）。
  // 精确说清是哪一道闸在拦：控制器类级就挂了 OrgMemberGuard（knowledge-bases.controller.ts:44-45），
  // other 不是 owner 组织的成员，所以 404 来自 OrgMemberGuard:41，请求根本走不到
  // KbPermissionGuard 里的 resolve——也就是本用例钉的是「非成员」（阶梯判定 0b 那一路），
  // 【不是】判定 0a「同组织成员拿别组织的 kbId」。后者在 e2e 与单测里都没有用例（0a 只由
  // getKb 的 WHERE org_id 兜着，改动时别把它当成已覆盖）
  it('hides KBs from other organizations', async () => {
    const owner = await registerOwner('c');
    const other = await registerOwner('d');
    const kb = await createKb(owner.agent, owner.orgId, 'Private', 'restricted');

    await other.agent
      .get(`/api/orgs/${owner.orgId}/knowledge-bases/${kb.body.id}`)
      .expect(404);
  });

  // 回归点：BUG-1 那次修复留下的正面半边——「按邮箱把已注册但不在本组织的人拉进来」要能走通，
  // 且拉进来之后他【先获得组织成员身份】才拿得到库授权（kb-members.service.ts:127-131 的分支 B1：
  // 不补 memberships 的话 resolve 的 0b 会直接返回 null，那行授权是死的）。
  // 三次断言各钉一件事：added:true 走的是授权分支不是邀请分支；/orgs/:orgId/members 有他
  // 证明成员关系真的写了；列表里 viewer 证明 0b 之后判定 3 命中。
  // 值得留意的现状：这条通道让「对该库是 manager 的普通成员」绕开了 invites.service 那道
  // 「member 不能签组织邀请」的门槛，被加的人没有点过任何确认（见 kb-members.service.ts:89-95）
  it('lets KB managers add an external existing user by email', async () => {
    const owner = await registerOwner('e');
    const kb = await createKb(owner.agent, owner.orgId, 'External', 'restricted');
    const manager = await joinMember(owner, 'e');
    await owner.agent
      .post(`/api/orgs/${owner.orgId}/knowledge-bases/${kb.body.id}/members`)
      .send({ userId: manager.userId, permission: 'manager' })
      .expect(201);

    const outsider = await registerOwner('f');

    const res = await manager.agent
      .post(`/api/orgs/${owner.orgId}/knowledge-bases/${kb.body.id}/members`)
      .send({ email: outsider.email, permission: 'viewer' })
      .expect(201);
    expect(res.body.added).toBe(true);

    const members = await outsider.agent
      .get(`/api/orgs/${owner.orgId}/members`)
      .expect(200);
    expect(members.body.some((m: { email: string }) => m.email === outsider.email)).toBe(true);

    const list = await outsider.agent
      .get(`/api/orgs/${owner.orgId}/knowledge-bases`)
      .expect(200);
    const item = list.body.find((x: { id: string }) => x.id === kb.body.id);
    expect(item.effectivePermission).toBe('viewer');
  });

  // 回归点：邮箱查无此人时的第三条分支（B2）——【只发链接、一行授权都不写】，
  // 权限必须等对方注册并接受邀请才落地（kb-members.service.ts:117-126 直接 return，
  // 消费在 auth.service.ts:128-147：先建 memberships，再因邀请带 kb_id/kb_permission 而 upsert 授权行）。
  // 因此本用例的三段是一个完整因果链：响应带 invited+token → 拿 token 注册 201 → 列表里出现 editor。
  // 名字里的 "grants on accept" 指的就是最后这一段；邀请链接本身的字段形状（url 前缀 /join/）
  // 只断言到 contains，没验 token 与 APP_ORIGIN 的拼接细节
  it('creates a KB-scoped invite for unknown emails and grants on accept', async () => {
    const owner = await registerOwner('g');
    const kb = await createKb(owner.agent, owner.orgId, 'Invited', 'restricted');
    const email = `new-guy-${Date.now()}@test.local`;

    const res = await owner.agent
      .post(`/api/orgs/${owner.orgId}/knowledge-bases/${kb.body.id}/members`)
      .send({ email, permission: 'editor' })
      .expect(201);
    expect(res.body.invited).toBe(true);
    expect(res.body.invite.token).toBeTruthy();
    expect(res.body.invite.url).toContain('/join/');

    const agent = request.agent(app.getHttpServer());
    await agent
      .post('/api/auth/register')
      .send({ name: 'New Guy', email, password: 'password123', inviteToken: res.body.invite.token })
      .expect(201);

    const list = await agent
      .get(`/api/orgs/${owner.orgId}/knowledge-bases`)
      .expect(200);
    const item = list.body.find((x: { id: string }) => x.id === kb.body.id);
    expect(item.effectivePermission).toBe('editor');
  });

  // 回归点：BUG-1 的负面半边。这条用例在修复前拿到的是 201（外组织用户的裸 userId 直接 upsert 进
  // knowledge_base_members，污染成员列表），修复靠 add 分支 A 的 isMember 复核
  // （kb-members.service.ts:110-113）。所以它钉的是「授权行不落库」这件事，
  // 后面那次 members 列表查询就是这件事的直接证据；名字里的 "bare userId" 强调的正是
  // 「只给 userId、不给邮箱」——只有这条路会被拒，邮箱分支（B1）反而会补成员关系。
  // 最后两段顺便钉住圈外人自己的视角：既进不了别人的组织（OrgMemberGuard 404），
  // 自己的列表里也没有这个库
  it('rejects a bare userId from another organization', async () => {
    const owner = await registerOwner('h');
    const kb = await createKb(owner.agent, owner.orgId, 'Cross Org', 'restricted');
    const outsider = await registerOwner('i');

    // 直接给外组织用户的 userId：不补成员关系，也不写授权行
    await owner.agent
      .post(`/api/orgs/${owner.orgId}/knowledge-bases/${kb.body.id}/members`)
      .send({ userId: outsider.userId, permission: 'viewer' })
      .expect(404);

    const members = await owner.agent
      .get(`/api/orgs/${owner.orgId}/knowledge-bases/${kb.body.id}/members`)
      .expect(200);
    expect(members.body.members.map((m: { userId: string }) => m.userId)).not.toContain(
      outsider.userId,
    );

    // 圈外人连本组织的库列表都拿不到；他自己的列表里自然也没有这个库
    await outsider.agent.get(`/api/orgs/${owner.orgId}/knowledge-bases`).expect(404);
    const ownList = await outsider.agent
      .get(`/api/orgs/${outsider.orgId}/knowledge-bases`)
      .expect(200);
    expect(ownList.body.map((item: { id: string }) => item.id)).not.toContain(kb.body.id);
  });

  // 回归点：BUG-1 的另一半——修复前这个不存在的 UUID 会走到 knowledge_base_members.user_id 外键上，
  // 由全局异常过滤器表现成 500（见 bug-1-report.md 的 RED 段）。
  // 现在它和「外组织的真实用户」塌成同一个 404（同一处 isMember 检查），
  // 也就是说这条防的不是「报错不好看」，而是「错误码差别泄漏 userId 是否存在」。
  // 硬编码的这个 UUID 不需要存在于库里：没有成员行就永远走不到外键那一步
  it('returns 404 rather than 500 for an unknown user id', async () => {
    const owner = await registerOwner('j');
    const kb = await createKb(owner.agent, owner.orgId, 'Unknown User', 'restricted');

    await owner.agent
      .post(`/api/orgs/${owner.orgId}/knowledge-bases/${kb.body.id}/members`)
      .send({ userId: '00000000-0000-4000-8000-000000000000', permission: 'viewer' })
      .expect(404);
  });
});
