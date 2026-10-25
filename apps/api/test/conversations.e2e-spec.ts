/**
 * 会话（对话历史）e2e：守「会话是按 (org_id, user_id) 归属的私有数据」这条租户隔离保证。
 * 值得单独钉的原因：读消息与删会话这两条路由【没有挂 KbPermissionGuard】
 * （chat.controller.ts:47-62 只有 @Get/@Delete，没有 @UseGuards/@RequireKbPermission），
 * 拦截点有两层，都得说清「谁在哪里拦」：① 控制器类级 @UseGuards(OrgMemberGuard)（chat.controller.ts:19）
 * 覆盖本控制器每条路由，非本组织成员在 org-member.guard.ts:41 就被 404 挡下，根本走不到服务层；
 * ② 成员身份过了之后，会话归属才由服务层的 findOwnedById + require（chat.service.ts#listMessages 与 #deleteConversation）
 * 按 (org_id, user_id) 现查现判——「路径参数里没有 :kbId，跨用户这一层只能先取行再判」。
 * 这条设计一旦被人「顺手加个 guard」或
 * 「去掉 user_id 条件」，本文件是唯一的报警器。
 * 仓储层的 WHERE 是三条件 id + org_id + user_id（conversations.repository.ts:97-101），
 * 跨组织与跨用户都塌成同一个 404「会话不存在」，对外不承认别人的会话存在。
 * 边界：不测问答本身（检索/生成/流式协议全在 realtime.e2e-spec.ts），
 *      也不测 messages 表的 sources/interrupted 落库形状（那边同样在 realtime 里断言）。
 * 夹具：setup() 每次都新建一个 owner + 一个 org 模式的知识库，所以「列表长度」这类断言
 *      天然只受本用例影响；整套没有 truncate，用例之间靠新组织的 id 隔离，不依赖执行顺序。
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/create-app';

describe('conversations', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());

  /** 一条用例一个独立租户：返回值里的三个 id 只属于这一次注册，别的用例改不到 */
  const setup = async (suffix: string) => {
    const agent = request.agent(app.getHttpServer());
    const res = await agent
      .post('/api/auth/register')
      .send({
        name: 'Owner',
        email: `conv-${suffix}-${Date.now()}@test.local`,
        password: 'password123',
        orgName: `Conv ${suffix}`,
      })
      .expect(201);
    const orgId = res.body.organizations[0].id as string;
    const kb = await agent
      .post(`/api/orgs/${orgId}/knowledge-bases`)
      .send({ name: 'Chat KB', accessMode: 'org' })
      .expect(201);
    return { agent, orgId, kbId: kb.body.id as string };
  };

  // 回归点：会话 CRUD 四步的形状（建→列表→读消息→删→列表为空）。
  // 单独说两点：新建会话不会有任何消息（messages.body 是 []，证明「空数组而不是 404」这条前端分支），
  // 以及删除后 list 变空——删的是 conversations 行，靠 user_id 条件而不是靠 kbId（chat.service.ts#deleteConversation）
  it('creates, lists, reads and deletes conversations', async () => {
    const { agent, orgId, kbId } = await setup('a');
    const created = await agent
      .post(`/api/orgs/${orgId}/knowledge-bases/${kbId}/conversations`)
      .send({ title: '第一次对话' })
      .expect(201);

    const list = await agent
      .get(`/api/orgs/${orgId}/knowledge-bases/${kbId}/conversations`)
      .expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].title).toBe('第一次对话');

    const messages = await agent
      .get(`/api/orgs/${orgId}/conversations/${created.body.id}/messages`)
      .expect(200);
    expect(messages.body).toEqual([]);

    await agent
      .delete(`/api/orgs/${orgId}/conversations/${created.body.id}`)
      .expect(200);

    const after = await agent
      .get(`/api/orgs/${orgId}/knowledge-bases/${kbId}/conversations`)
      .expect(200);
    expect(after.body).toEqual([]);
  });

  // 回归点：别人的会话读不到（404，不是 200 空列表，也不是 403）。
  // 精确说明这条证明了什么、没证明什么：请求里【同时】换了人和换了 orgId
  // （second.agent + second.orgId 去读 first 的 conversationId），
  // 而 findOwnedById 的 WHERE 是 id + org_id + user_id 三个条件（conversations.repository.ts:99），
  // 所以 404 无法区分是 user_id 还是 org_id 拦下的——名字说的是 "another user"，
  // 断言其实只证明「人和组织都换了就进不去」。
  // 真正的「同组织、换用户」那一维在本文件没有用例；后续要收紧隔离时别把它当成已覆盖。
  it('hides another user conversation', async () => {
    const first = await setup('b');
    const second = await setup('c');
    const created = await first.agent
      .post(`/api/orgs/${first.orgId}/knowledge-bases/${first.kbId}/conversations`)
      .send({ title: 'private' })
      .expect(201);

    await second.agent
      .get(`/api/orgs/${second.orgId}/conversations/${created.body.id}/messages`)
      .expect(404);
  });
});
