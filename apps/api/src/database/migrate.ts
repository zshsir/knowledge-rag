/**
 * 独立迁移脚本（Docker 里作为一次性 migrate 容器运行）。
 * 步骤：
 * 1. 先连到 maintenance db（postgres），目标库不存在时创建——首次部署能自愈
 * 2. 拿 pg advisory lock，避免多实例同时迁移
 * 3. 读 MIGRATIONS_DIR 下 .sql 按文件名升序逐条执行；迁移必须幂等（IF NOT EXISTS）
 * 4. 记录已应用迁移，重复执行不会二次生效
 *
 * 职责边界：
 * - 只按文件名顺序执行 migrations/ 下的 SQL，不生成、不回滚、不做 down 迁移
 * - 不读 Nest 的配置服务（本脚本是独立进程），环境变量靠 load-env.ts 自己加载
 * - 迁移失败即退出码 1，容器随之结束，让编排层暴露问题而不是假装成功
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from 'pg';
import { loadConfig } from '../config/load-env';

// 合法库名白名单：CREATE DATABASE 不能用 $1 占位符参数化，只能拼字符串，所以先校验再拼接，堵住注入
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * 保证目标库存在。
 *
 * 步骤：
 * 1. 校验 DB_NAME 形如合法标识符，否则直接拒绝——拼接进 DDL 之前必须有这道闸
 * 2. 连到 postgres 这个维护库（不能连还不存在的目标库）
 * 3. 查 pg_database 判断目标库是否存在，不存在才 CREATE，存在就跳过，保证脚本可反复执行
 */
async function ensureDatabase() {
  const cfg = loadConfig();
  if (!IDENTIFIER.test(cfg.db.database)) {
    throw new Error(`Invalid DB_NAME: ${cfg.db.database}`);
  }

  const admin = new Client({ ...cfg.db, database: 'postgres' });
  await admin.connect();
  try {
    const exists = await admin.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [cfg.db.database],
    );
    if (!exists.rowCount) {
      await admin.query(`CREATE DATABASE "${cfg.db.database}"`);
      console.log(`created database ${cfg.db.database}`);
    }
  } finally {
    await admin.end();
  }
}

/**
 * 执行全部迁移。
 *
 * 步骤：
 * 1. 先调 ensureDatabase，确保库存在再连上去
 * 2. pg_advisory_lock(hashtext(key))：锁键是自定义字符串，多个 migrate 容器同时启动时后来者会排队等待，
 *    避免两个进程并发建表互相撞车
 * 3. 建 schema_migrations 记账表（IF NOT EXISTS，本脚本自身也要幂等）
 * 4. 读目录、只取 .sql、按文件名升序：文件名以序号前缀开头，顺序即依赖顺序
 * 5. 每个文件先查有没有记过账，已应用就跳过；未应用则在事务里「执行 SQL + 写账本」，两步同生同死
 * 6. finally 里无论成败都解锁并断开，锁不会遗留阻塞下一次迁移
 */
async function runMigrations() {
  await ensureDatabase();
  const cfg = loadConfig();
  const client = new Client({ ...cfg.db, database: cfg.db.database });
  await client.connect();
  const lockKey = 'knowledge_rag_migrations';
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    // 迁移目录默认取 cwd 下的 migrations/（本地 npm run migrate 与容器 WORKDIR 都正好命中）；
    // 留一个 MIGRATIONS_DIR 覆盖口，是为了换部署布局（dist 与 SQL 不同层）时不用改代码
    const migrationsDir =
      process.env.MIGRATIONS_DIR ?? join(process.cwd(), 'migrations');
    const files = (await readdir(migrationsDir))
      .filter((file) => file.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const applied = await client.query(
        'SELECT 1 FROM schema_migrations WHERE version = $1',
        [file],
      );
      if (applied.rowCount) continue;

      const sql = await readFile(join(migrationsDir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations(version) VALUES ($1)',
          [file],
        );
        await client.query('COMMIT');
        console.log(`applied ${file}`);
      } catch (error) {
        // 半成品 SQL 一律回滚，账本里不会留下「已应用」的假记录，下次重跑还能干净地再来一遍
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]);
    } finally {
      await client.end();
    }
  }
}

// 顶层入口：迁移失败必须让进程以非 0 退出，CI 与 compose 靠退出码判断部署是否成功
runMigrations().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
