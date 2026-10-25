/**
 * 数据库形状 e2e：在跑其它 e2e 之前先把「代码假设的库结构真的存在」钉住。
 * 它守的是迁移层契约，不是业务行为：
 * - pgvector 扩展必须已装（migrations/001_init.sql:1 `CREATE EXTENSION IF NOT EXISTS vector`），
 *   否则 chunks 表的 `vector(1024)` 列与检索里的 `<=>` 运算符都无从存在
 * - public schema 下十一张业务表齐全（users/sessions/organizations/memberships/invites/
 *   knowledge_bases/knowledge_base_members/documents/chunks/conversations/messages）
 * 前置条件：`npm run test:e2e` 的 pretest 会先跑 `migrate:test`（package.json:13、15-16），
 * 且 setup-env.ts 把 DB_NAME 兜成 knowledge_rag_test；这两步没做对，本文件就是最先红的地方。
 * 边界与如实说明：
 * - 用的是 `expect.arrayContaining`，只证明「这十一张表都在」，不证明「public 下没有别的表」
 * - 列级约束（CHECK、UNIQUE (org_id,user_id)、lower(email) 唯一索引、chunks.embedding 的
 *   vector(1024) NOT NULL）这里一律没测；维度 1024 只在 ingestion.e2e-spec.ts 里
 *   以 `min(vector_dims(embedding))` 间接钉住
 * - pg-boss 自己的表在 pgboss schema 下，被这里的 `table_schema = 'public'` 排除，不参与判断
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/create-app';
import { DatabaseService } from '../src/database/database.service';

describe('database', () => {
  let app: INestApplication;
  let db: DatabaseService;

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DatabaseService);
  });
  afterAll(() => app.close());

  // 回归点：迁移漏跑 / 跑错库 / 换了不带 pgvector 镜像时，这里给出比「某个业务用例 SQL 报错」更好定位的红
  it('has vector extension and core tables', async () => {
    const ext = await db.query<{ extversion: string }>(
      "SELECT extversion FROM pg_extension WHERE extname = 'vector'",
    );
    // 扩展是库级对象，装在 public 之外的 schema 也会算 1 行，这里只判「装没装」
    expect(ext.rowCount).toBe(1);

    const tables = await db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    const names = tables.rows.map((row) => row.table_name);
    expect(names).toEqual(
      expect.arrayContaining([
        'users',
        'sessions',
        'organizations',
        'memberships',
        'invites',
        'knowledge_bases',
        'knowledge_base_members',
        'documents',
        'chunks',
        'conversations',
        'messages',
      ]),
    );
  });

  // 回归点：把上面的形状检查与「HTTP 侧真的连得上同一个库」连起来看——
  // 直接查库能读到、探针也说 db:ok，才算迁移跑到的库和进程连的库是同一个
  // 注意这条与 health.e2e-spec.ts 的用例是同一组断言（status/db），刻意重叠，两处都会一起红
  it('health reports db ok', async () => {
    const res = await request(app.getHttpServer()).get('/api/health').expect(200);
    expect(res.body).toMatchObject({ status: 'ok', db: 'ok' });
  });
});
