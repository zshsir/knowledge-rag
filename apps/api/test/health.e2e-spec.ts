/**
 * 健康探针 e2e：守住「/api/health 是匿名可访问的，且它报的 ok 是真的探过库」这一条运维契约。
 * 它是部署编排（docker compose 的 healthcheck）唯一依赖的接口，探错了会让一个连不上库的实例被当成健康。
 * 契约细节（都在 src/health/health.controller.ts）：
 * - @Public()：不带会话也必须 200，否则容器启动阶段探针会一直失败（AuthGuard 步骤 1 的豁免，
 *   见 src/common/guards/auth.guard.ts:35-39）
 * - 控制器先 `SELECT 1` 再返回 {status:'ok', db:'ok', queue}；queue 不是 'ok' 时抛 503
 * - 这里的 app 是真实的 AppModule（test/utils/create-app.ts），所以「起得来」本身就意味着
 *   QueueService.onModuleInit 里的 pg-boss 已经连上同一个测试库
 * 边界：本文件不判权限、不碰业务表；数据库结构假设由 database.e2e-spec.ts 守，
 *      那条用例同样断了一次 health，两个 suite 刻意重叠（一个证明「库形状对」，一个证明「匿名可达」）。
 * 未覆盖（照现状记录，别误以为这里都测了）：
 * - 返回体里的 queue 字段没有任何断言，503「任务队列未就绪」那条分支（health.controller.ts:18-21）全仓无用例
 * - 探针在库挂掉时的表现没有用例（要真把库断开才能测，e2e 没有这个夹具）
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/create-app';

describe('health', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());

  // 回归点：有人给 @Get() 摘掉 @Public()（或挪走全局 AuthGuard 的豁免）时，这条会先变成 401
  it('GET /api/health', async () => {
    const res = await request(app.getHttpServer()).get('/api/health').expect(200);
    expect(res.body).toMatchObject({ status: 'ok', db: 'ok' });
  });
});
