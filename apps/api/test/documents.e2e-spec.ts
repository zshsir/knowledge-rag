/**
 * 文档 API e2e：守四条不可回退的契约，都是「单测里用假仓储测不出来」的那类。
 * 1. 租户隔离的对外口径：跨组织拿别人的 documentId → 404「文档不存在」，
 *    与「真的不存在」同一句话（documents.service.ts:187-188 的 findById 带 org_id，
 *    配合 kbAccess.require 的 null→404）；只有「可达但等级不够」才给 403（kb-access.service.ts:107）
 * 2. 权限门槛的实际等级：下载/看分片要 viewer，删除/上传要 editor。org 模式的知识库里
 *    普通组织成员靠判定 4 拿到 viewer，所以能下载却不能删（kb-access.service.ts:41-51）
 * 3. 上传闸口的顺序：扩展名白名单在先、magic bytes 在后（document-validation.ts:112-134），
 *    不合格的字节既不留磁盘目录也不写库行
 * 4. storageKey 永不出现在响应里（documents.service.ts:40-43 的 publicDocument），
 *    但删库要把这个键对应的磁盘目录真的清掉（knowledge-bases.service.ts:236 → storage.service.ts:197）
 * 环境假设（改这个文件前先接受）：
 * - 真库 + 真磁盘：UPLOAD_DIR 是 ./test/tmp-uploads（test/setup-env.ts:5），
 *   用例会往那里写真文件并断言 exists() 翻转，不是内存假存储
 * - 【没有 worker】：IngestionProcessor 只注册在 WorkerModule，API 侧只投递（queue.service.ts:14-15），
 *   所以上传后文档就应当停在 queued，本文件里的文档永远不会变 ready，也不会产生 chunks
 * - 无 truncate：每个用例新建组织/库，列表长度类断言因此只受本用例影响；用例之间不依赖执行顺序
 * - 最后一条用例里手拼的 storageKey（'orgs/.../documents/<id>/<name>'）与 storage.service.ts:118-126
 *   的拼法是【两份同内容代码】：那边改了键的形状，这里会以「exists 一直是 false」的形式红
 * 未覆盖（照现状记录）：体积上限（document-validation.ts:107）、DOCX 的 magic bytes（:129-133）、
 * 分片查看接口 listChunks、重试接口 retry，本文件都没有用例。
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { posix } from 'node:path';
import { createTestApp } from './utils/create-app';
import { StorageService } from '../src/storage/storage.service';

type TestAgent = ReturnType<typeof request.agent>;

describe('documents', () => {
  let app: INestApplication;
  // 直接拿真实的 StorageService 而不是假对象：本文件要证的正是「磁盘上到底有没有这个文件」，
  // 换成假的 exists 就只能证明 handler 调用了一个函数，证明不了删库清盘
  let storage: StorageService;

  /** 新建一个自带 owner 的组织：每个用例一套，避免任何跨用例的权限数据 */
  const registerOwner = async (suffix: string) => {
    const agent = request.agent(app.getHttpServer());
    const res = await agent
      .post('/api/auth/register')
      .send({
        name: 'Owner',
        email: `doc-owner-${suffix}-${Date.now()}@test.local`,
        password: 'password123',
        orgName: `Doc Org ${suffix}`,
      })
      .expect(201);
    return { agent, orgId: res.body.organizations[0].id };
  };

  /** accessMode 固定 'org'：本文件的权限对照全靠这个默认模式带来的继承 viewer */
  const createKb = async (agent: TestAgent, orgId: string) => {
    const res = await agent
      .post(`/api/orgs/${orgId}/knowledge-bases`)
      .send({ name: 'Docs KB', accessMode: 'org' })
      .expect(201);
    return res.body.id as string;
  };

  /**
   * 造一个「同组织的普通 member」：走真实的邀请→注册链路，而不是往 memberships 插一行假数据，
   * 这样他才有合法会话 Cookie，能真正过 OrgMemberGuard / KbPermissionGuard。
   * 关键点是【不给他任何 knowledge_base_members 授权行】——他对该库的 viewer 完全来自
   * org 模式的判定 4（kb-access.service.ts:80），这正是上面那条 200/403 对照的前提
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
        email: `doc-member-${suffix}-${Date.now()}@test.local`,
        password: 'password123',
        inviteToken: invite.body.token,
      })
      .expect(201);
    return { agent, userId: res.body.user.id as string };
  };

  beforeAll(async () => {
    app = await createTestApp();
    storage = app.get(StorageService);
  });
  afterAll(() => app.close());

  // 一条长用例走完整圈，逐步各钉一个回归点（顺序有意义：后一步的身份都靠前一步的授权）
  it('uploads, lists, downloads, authorizes and deletes documents', async () => {
    const owner = await registerOwner('a');
    const kbId = await createKb(owner.agent, owner.orgId);

    // 步骤 1：上传只到 queued（API 进程不消费），且响应里没有 storageKey —— 这两条同一次断言，
    // 防止将来有人为了「方便前端」把内部磁盘路径直接回出去
    const uploaded = await owner.agent
      .post(`/api/orgs/${owner.orgId}/knowledge-bases/${kbId}/documents`)
      .attach('file', Buffer.from('hello knowledge'), {
        filename: 'notes.txt',
        contentType: 'text/plain',
      })
      .expect(201);
    expect(uploaded.body.status).toBe('queued');
    expect(uploaded.body.storageKey).toBeUndefined();
    const documentId = uploaded.body.id as string;

    // 步骤 2：列表按 created_at 倒序（排序写在仓储里），这里只够验「有一条且文件名对」
    const list = await owner.agent
      .get(`/api/orgs/${owner.orgId}/knowledge-bases/${kbId}/documents`)
      .expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].filename).toBe('notes.txt');

    // 步骤 3：下载拿到的是当初上传的那份字节本身（正文一致才算「storageKey→磁盘」这条链没接错）
    await owner.agent
      .get(`/api/orgs/${owner.orgId}/documents/${documentId}/download`)
      .expect(200)
      .expect((res) => {
        expect(res.text).toBe('hello knowledge');
      });

    // 步骤 4：org 模式的库里，普通组织成员靠判定 4 继承 viewer，所以只读下载放行……
    const member = await joinMember(owner, 'a');
    await member.agent
      .get(`/api/orgs/${owner.orgId}/documents/${documentId}/download`)
      .expect(200);

    // ……但删除要 editor，viewer 不够 → 403。404/403 这条分界在整套里【不止一处】，按资源层级各钉各的：
    // 知识库级（kbId）由 knowledge-bases.e2e-spec.ts 钉（改名、看成员名单 403，跨组织详情 404）；
    // 组织级由 organizations.e2e-spec.ts 钉（非 owner/admin 改成员角色与发邀请 403，:82/:92；
    // 圈外人拿别人的成员列表 404，:126）；会话级由 conversations.e2e-spec.ts:98 钉（跨组织读消息 404）；
    // 本文件是【唯一】在文档级（按 :documentId）路由上钉住这条分界的地方——同一个人下载（viewer）200、
    // 删除（要 editor）403，跨组织拿别人的 documentId 又塌成 404（见下面步骤 6）。
    // 门槛参数才是本用例独有的目标：有人把 require 的 required 参数改成 viewer，这里的 403 立刻变 200。
    // 注意 auth.e2e-spec.ts:75 那条 403 不算这一族——它是 OriginGuard 的跨站拦截，与租户判权无关
    await member.agent
      .delete(`/api/orgs/${owner.orgId}/documents/${documentId}`)
      .expect(403);

    // 步骤 5：显式授权成 editor 之后同一个人就能上传（判定 3 排在判定 4 之前，所以是 editor 不是 viewer）
    await owner.agent
      .post(`/api/orgs/${owner.orgId}/knowledge-bases/${kbId}/members`)
      .send({ userId: member.userId, permission: 'editor' })
      .expect(201);

    const memberUpload = await member.agent
      .post(`/api/orgs/${owner.orgId}/knowledge-bases/${kbId}/documents`)
      .attach('file', Buffer.from('member content'), {
        filename: 'member.md',
        contentType: 'text/markdown',
      })
      .expect(201);

    // 步骤 6：另一个组织的 owner 拿真实 documentId 来下载 → 404，
    // 挡住的是「按主键查就完事」这种写法（findById 少了 org_id 条件就会变成 200 泄露内容）
    const other = await registerOwner('b');
    await other.agent
      .get(`/api/orgs/${owner.orgId}/documents/${memberUpload.body.id}/download`)
      .expect(404);

    // 步骤 7：owner 删成功后，再下载应当 404（行没了）。
    // 如实说明：documents.service.ts:216 那一步 storage.removeDocumentDir 确实被执行了，
    // 但本用例没有断言磁盘目录被删干净——目录级的删除证明在第三条用例（removeKbDir）那里
    await owner.agent
      .delete(`/api/orgs/${owner.orgId}/documents/${memberUpload.body.id}`)
      .expect(200);
    await owner.agent
      .get(`/api/orgs/${owner.orgId}/documents/${memberUpload.body.id}/download`)
      .expect(404);
  });

  // 回归点：两道闸各自挡什么——bad.exe 挡在扩展名白名单（document-validation.ts:112-116），
  // fake.pdf 声明的 MIME 与 .pdf 是配得上的，所以它必须被 magic bytes 拦下（:122-128），
  // 这一条专门防「只看 Content-Type 就把伪装文件收进来」的改法
  it('rejects unsupported files and invalid magic bytes', async () => {
    const owner = await registerOwner('c');
    const kbId = await createKb(owner.agent, owner.orgId);

    await owner.agent
      .post(`/api/orgs/${owner.orgId}/knowledge-bases/${kbId}/documents`)
      .attach('file', Buffer.from('bad'), {
        filename: 'bad.exe',
        contentType: 'application/octet-stream',
      })
      .expect(400);

    await owner.agent
      .post(`/api/orgs/${owner.orgId}/knowledge-bases/${kbId}/documents`)
      .attach('file', Buffer.from('not a pdf'), {
        filename: 'fake.pdf',
        contentType: 'application/pdf',
      })
      .expect(400);
  });

  // 回归点：删库必须把磁盘子树一起删掉——数据库靠 FK CASCADE，磁盘不在这个事务里，
  // 漏掉 removeKbDir 的代价是孤儿目录无限增长，没人再能清它（清理全靠 documentId 反查库行）。
  // 这里先用手拼的 storageKey 证明「文件确实在盘上」，删库后再证明「不在了」，
  // 两个 exists() 缺一个这条用例就退化成「DELETE 返回了 200」。
  // 注意 exists() 的实现把任何异常都归一成 false（storage.service.ts:148-155），
  // 所以 false 也包含「键拼错了」这种情形——正因如此前面那次 true 才是必要的对照组
  it('deletes the knowledge base and its stored files', async () => {
    const owner = await registerOwner('d');
    const kbId = await createKb(owner.agent, owner.orgId);
    const uploaded = await owner.agent
      .post(`/api/orgs/${owner.orgId}/knowledge-bases/${kbId}/documents`)
      .attach('file', Buffer.from('to be removed'), {
        filename: 'remove.txt',
        contentType: 'text/plain',
      })
      .expect(201);

    // 与 storage.service.ts:118-126 的键拼法手工对齐（文件名 remove.txt 是 ASCII，
    // 过 sanitizeFilename 不会变形，所以这里可以直接把名字写死）
    const storageKey = posix.join(
      'orgs',
      owner.orgId,
      'knowledge-bases',
      kbId,
      'documents',
      uploaded.body.id,
      'remove.txt',
    );
    await expect(storage.exists(storageKey)).resolves.toBe(true);

    await owner.agent
      .delete(`/api/orgs/${owner.orgId}/knowledge-bases/${kbId}`)
      .expect(200);
    await expect(storage.exists(storageKey)).resolves.toBe(false);

    await owner.agent
      .get(`/api/orgs/${owner.orgId}/knowledge-bases/${kbId}`)
      .expect(404);
  });
});
