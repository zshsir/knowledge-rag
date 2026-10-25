/**
 * 认证 HTTP 边界 e2e：守「会话 Cookie 的整条生命周期」和「跨站写请求必被拒」这两条安全契约。
 * 覆盖的是控制器 + 守卫 + 会话签发的接线；密码哈希、令牌摘要这些内部规则由 src/auth 下的单测管。
 * 契约清单（每条都能对上生产代码）：
 * - 注册即登录：AuthService.register 落用户与组织，控制器紧接着 createSession 并写 Cookie
 *   （auth.controller.ts:62-75）；Cookie 名 kr_session、httpOnly、sameSite=lax（:46-54）
 * - 登出删的是服务端会话行，此后同一个 Cookie 必然 401
 *   （session.service.ts:62-64 → auth.guard.ts:49-52）；本系统没有滑动续期，
 *   expires_at 在签发时就算死（session.service.ts:36-38）
 * - Origin 守卫对写方法生效，且对 @Public 路由同样生效（origin.guard.ts:2、37-43）——
 *   登录/注册是 @Public 的，跨站照样 403
 * - 限流在测试环境整体豁免（app-throttler.guard.ts:21 看 NODE_ENV==='test'），
 *   所以本文件可以连着发注册请求；这也意味着 e2e 完全测不到生产那套 5 次/分、10 次/时的额度
 * 数据假设：真库 knowledge_rag_test，且【没有任何 truncate】——
 * test/utils/db.ts 里的 resetDatabase 目前没有任何 e2e 引用，隔离全靠
 * 每条用例自己新建用户/组织（邮箱带 Date.now()）与 test/setup-env.ts 的环境变量兜底。
 * BCRYPT_ROUNDS 被压到 4（setup-env.ts:4）只为让注册快起来，不影响正确性。
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/create-app';

describe('auth', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());

  // 回归点：注册→me→登出→me 这一段是前端恢复登录态与掉线的唯一路径。
  // 拆开来钉的三件事：register 带回自建组织且角色是 owner（auth.service.ts:158-169 硬编码 owner）、
  // /auth/me 靠 Cookie 里的令牌反查会话而不是靠请求体自报身份、logout 之后同一个 agent 必须 401
  it('registers, returns me and logs out', async () => {
    const agent = request.agent(app.getHttpServer());
    const email = `owner-${Date.now()}@test.local`;

    await agent
      .post('/api/auth/register')
      .send({
        name: 'Owner',
        email,
        password: 'password123',
        orgName: 'Acme',
      })
      .expect(201)
      .expect((res) => {
        expect(res.body.user.email).toBe(email);
        expect(res.body.organizations[0].role).toBe('owner');
      });

    // 这一步只验「会话可用」，返回体里没有新的判断信息：身份来自 AuthGuard 挂上的 request.user
    await agent
      .get('/api/auth/me')
      .expect(200)
      .expect((res) => {
        expect(res.body.user.email).toBe(email);
      });

    // 登出后仍用同一个 agent（同一个 Cookie），401 才证明服务端行真的被删了
    // 注意：本用例没断言 Set-Cookie 也被清掉（auth.controller.ts:105 的 clearCookie），
    // 浏览器侧少这一步不影响安全边界，但断言确实没覆盖到它
    await agent.post('/api/auth/logout').expect(200);
    await agent.get('/api/auth/me').expect(401);
  });

  // 回归点：Origin 守卫被摘掉/改成只对非 @Public 路由生效时，这条会先变成 200/401 而不是 403。
  // 登录路由本身是 @Public 的，所以 403 只可能来自 OriginGuard（origin.guard.ts:41-42），
  // 断言里没带任何 Cookie：说明这道闸与登录态无关，是纯字符串比较
  it('rejects bad origin on writes', async () => {
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('Origin', 'http://evil.example')
      .send({ email: 'x@test.local', password: 'password123' })
      .expect(403);
  });

  // 回归点：账号不存在必须回 401（不是 404/500）。
  // 名字里的 wrong credentials 只测了「邮箱查无此人」这一支；
  // 「密码错」那一支（auth.service.ts:200-201）与「两种失败文案相同、无法枚举账号」
  // 这条防线索外泄的契约，本文件没有任何断言（连返回的 message 都没比），改动时别把它当已覆盖
  it('rejects wrong credentials', async () => {
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'nobody@test.local', password: 'password123' })
      .expect(401);
  });
});
