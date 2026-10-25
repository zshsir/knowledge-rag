# Knowledge RAG 多租户问答平台 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付一个可部署到阿里云 ECS 的多租户知识库 RAG 平台，覆盖登录、组织与知识库权限、文档异步入库、实时问答、WebSocket 推送和 Docker 部署。

**Architecture:** npm workspaces 单仓库。NestJS API 负责认证、组织、知识库、文档、聊天和 WebSocket；独立 NestJS worker 进程消费 pg-boss 队列，使用 PostgreSQL + pgvector 存储与检索；React SPA 由 Nginx 托管并通过 `/api` 与 `/socket.io` 反向代理到 API。多租户通过 `org_id` 共享表隔离，权限在守卫和服务层双重校验。

**Tech Stack:** NestJS 11、TypeScript、pg、pg-boss 11.1.2（CommonJS）、Socket.IO 4、pdf-parse 2、mammoth、bcryptjs、React 19、Vite 8、Tailwind CSS 4、TanStack Query、Vitest、Docker Compose、Nginx。

**Spec:** `docs/superpowers/specs/2026-10-23-knowledge-rag-design.md`

## Global Constraints

- 本地 Node.js 24；npm 11；Docker 运行时使用服务器已有 Node 22.22 基础镜像；npm workspaces；后端固定 NestJS 11，不升级到 12。
- 数据库为现有 PostgreSQL 15 + pgvector；开发库 `knowledge_rag_dev`，测试库 `knowledge_rag_test`，生产库 `knowledge_rag`；绝不能把业务表写入 `postgres` 或 `travel_db`。
- 队列使用 pg-boss，**不引入 Redis**。
- 开发端口：API `3300`、Web `5173`；生产宿主端口 `8088`。绝不修改或重启现有容器（`xflow-*`、`travel-*`、`pgvector`、`my-mysql`），不占用 80/8000/3306/5432。
- 目标服务器 2 vCPU / 1.8GB 内存：Worker 并发 `1`，API Node heap 256MB，Worker Node heap 384MB；镜像串行构建。
- Session 使用 httpOnly Cookie；不把 JWT 放入 localStorage。所有写请求与 WebSocket 握手校验 `Origin`。
- 所有业务查询必须带 `org_id`；不得只依赖前端过滤。
- 不提交 `.env`、`deploy/.env.production`、上传文件、构建产物；不在日志中输出密码、Cookie、API Key。
- 本仓库尚未初始化 git，用户未要求提交；每个任务以测试/类型检查/构建验证结束，**不要执行 git commit**，直到用户明确要求。
- 每项任务遵循 TDD：先写失败测试 → 运行确认失败 → 最小实现 → 运行确认通过 → 跑完整验证。

## File Map

```text
knowledge-rag/
├─ package.json
├─ .gitignore
├─ tsconfig.base.json
├─ apps/
│  ├─ api/
│  │  ├─ package.json / nest-cli.json / tsconfig.json / tsconfig.build.json
│  │  ├─ jest.config.ts / test/jest-e2e.json
│  │  ├─ migrations/001_init.sql
│  │  ├─ src/
│  │  │  ├─ main.ts / worker.ts / app.module.ts / worker.module.ts
│  │  │  ├─ config/config.module.ts / config.service.ts
│  │  │  ├─ database/database.module.ts / database.service.ts / migrate.ts
│  │  │  ├─ database/repositories/*.ts
│  │  │  ├─ common/decorators/*.ts
│  │  │  ├─ common/guards/*.ts
│  │  │  ├─ common/middleware/origin.middleware.ts
│  │  │  ├─ common/filters/all-exceptions.filter.ts
│  │  │  ├─ common/events/access-events.service.ts
│  │  │  ├─ auth/*
│  │  │  ├─ organizations/*
│  │  │  ├─ knowledge-bases/*
│  │  │  ├─ storage/*
│  │  │  ├─ documents/*
│  │  │  ├─ queue/*
│  │  │  ├─ ingestion/parsing/*
│  │  │  ├─ llm/*
│  │  │  ├─ chat/*
│  │  │  ├─ realtime/*
│  │  │  └─ health/*
│  │  ├─ test/*.e2e-spec.ts
│  │  └─ Dockerfile
│  └─ web/
│     ├─ package.json / vite.config.ts / tsconfig*.json / index.html
│     ├─ src/main.tsx / app/*
│     ├─ src/components/ui/*
│     ├─ src/features/*
│     ├─ src/lib/*
│     ├─ src/styles/index.css
│     ├─ nginx.conf
│     └─ Dockerfile
├─ deploy/docker-compose.yml
├─ deploy/.env.production.example
├─ deploy/DEPLOY.md
└─ docs/superpowers/{specs,plans}/
```

---

## Phase 0 — 基座

### Task 1: Workspace、API 骨架与健康检查

**Files:**
- Create: `package.json`, `.gitignore`, `tsconfig.base.json`, `README.md`
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/tsconfig.build.json`, `apps/api/nest-cli.json`
- Create: `apps/api/src/main.ts`, `apps/api/src/app.module.ts`, `apps/api/src/health/health.module.ts`, `apps/api/src/health/health.controller.ts`
- Create: `apps/api/jest.config.ts`, `apps/api/test/jest-e2e.json`, `apps/api/test/utils/create-app.ts`, `apps/api/test/health.e2e-spec.ts`
- Modify: `.env`（只追加非敏感默认项，保留现有密钥）

**Interfaces:**
- Produces: `GET /api/health` → `200 {status:"ok"}`
- Produces: workspace names `@knowledge-rag/api`、`@knowledge-rag/web`；根脚本 `dev`、`build`、`typecheck`、`test`

- [ ] **Step 1: 写失败的 e2e 测试**

```ts
// apps/api/test/health.e2e-spec.ts
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/create-app';

describe('health', () => {
  let app: INestApplication;
  beforeAll(async () => { app = await createTestApp(); });
  afterAll(() => app.close());

  it('GET /api/health', async () => {
    const res = await request(app.getHttpServer()).get('/api/health').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});
```

`jest.config.ts`（单元测试）：

```ts
import type { Config } from 'jest';
export default {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: { '^.+\\.(t|j)s$': 'ts-jest' },
  testEnvironment: 'node',
} satisfies Config;
```

`test/utils/create-app.ts`（所有 e2e 统一入口，确保 CookieParser/ValidationPipe/前缀与生产一致）：

```ts
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { AppModule } from '../../src/app.module';

export async function createTestApp(): Promise<INestApplication> {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = mod.createNestApplication();
  app.setGlobalPrefix('api');
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  return app;
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test:e2e -w @knowledge-rag/api -- health`
Expected: FAIL，提示 `Cannot find module '../src/app.module'`。

- [ ] **Step 3: 创建 workspace 与最小 Nest 应用**

`package.json`（根）：

```json
{
  "name": "knowledge-rag",
  "private": true,
  "version": "1.0.0",
  "workspaces": ["apps/*"],
  "scripts": {
    "dev": "concurrently -n api,worker,web -c blue,yellow,green \"npm:dev:api\" \"npm:dev:worker\" \"npm:dev:web\"",
    "dev:api": "npm run start:dev -w @knowledge-rag/api",
    "dev:worker": "npm run start:worker:dev -w @knowledge-rag/api",
    "dev:web": "npm run dev -w @knowledge-rag/web",
    "build": "npm run build -w @knowledge-rag/api && npm run build -w @knowledge-rag/web",
    "typecheck": "npm run typecheck -w @knowledge-rag/api && npm run typecheck -w @knowledge-rag/web",
    "test": "npm run test -w @knowledge-rag/api && npm run test -w @knowledge-rag/web",
    "db:migrate": "npm run migrate -w @knowledge-rag/api",
    "db:migrate:test": "npm run migrate:test -w @knowledge-rag/api"
  },
  "devDependencies": {
    "concurrently": "^9.2.0",
    "cross-env": "^10.0.0"
  }
}
```

`apps/api/package.json` 依赖按以下精确集合安装（版本以安装时最新 patch 为准）：

```json
{
  "name": "@knowledge-rag/api",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "start:dev": "nest start --watch",
    "start:worker:dev": "ts-node src/worker.ts",
    "build": "nest build",
    "start:prod": "node dist/main.js",
    "start:worker": "node dist/worker.js",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "migrate": "tsx src/database/migrate.ts",
    "migrate:test": "cross-env DB_NAME=knowledge_rag_test tsx src/database/migrate.ts",
    "test": "jest --runInBand",
    "pretest:e2e": "npm run migrate:test",
    "test:e2e": "cross-env DB_NAME=knowledge_rag_test jest --config test/jest-e2e.json --runInBand"
  },
  "dependencies": {
    "@nestjs/common": "^11.1.0",
    "@nestjs/config": "^4.0.2",
    "@nestjs/core": "^11.1.0",
    "@nestjs/platform-express": "^11.1.0",
    "@nestjs/platform-socket.io": "^11.1.0",
    "@nestjs/throttler": "^6.4.0",
    "@nestjs/websockets": "^11.1.0",
    "bcryptjs": "^3.0.2",
    "class-transformer": "^0.5.1",
    "class-validator": "^0.14.2",
    "cookie-parser": "^1.4.7",
    "helmet": "^8.1.0",
    "iconv-lite": "^0.7.0",
    "mammoth": "^1.13.0",
    "pdf-parse": "^2.4.5",
    "pg": "^8.16.3",
    "pg-boss": "^11.1.2",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.2",
    "socket.io": "^4.8.4"
  },
  "devDependencies": {
    "@nestjs/cli": "^11.0.10",
    "@nestjs/testing": "^11.1.0",
    "@types/cookie-parser": "^1.4.9",
    "@types/express": "^5.0.3",
    "@types/jest": "^30.0.0",
    "@types/multer": "^2.0.0",
    "@types/node": "^24.3.0",
    "@types/pg": "^8.15.5",
    "@types/supertest": "^6.0.3",
    "docx": "^9.5.1",
    "jest": "^30.1.1",
    "pdfkit": "^0.17.2",
    "supertest": "^7.1.4",
    "ts-jest": "^29.4.1",
    "tsx": "^4.20.5",
    "typescript": "^5.9.2"
  }
}
```

`main.ts`：

```ts
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.use(cookieParser());
  app.use(helmet());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(process.env.PORT ? Number(process.env.PORT) : 3300);
}
void bootstrap();
```

`health.controller.ts`：

```ts
import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  check() {
    return { status: 'ok' };
  }
}
```

补充 `.gitignore`（必须包含）：

```gitignore
node_modules/
dist/
coverage/
.env
.env.*
!.env.example
deploy/.env.production
apps/api/storage/
*.log
.DS_Store
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm install && npm run test:e2e -w @knowledge-rag/api -- health`
Expected: PASS，1 个测试通过。

- [ ] **Step 5: 构建与类型检查**

Run: `npm run build -w @knowledge-rag/api && npm run typecheck -w @knowledge-rag/api`
Expected: 均退出码 0。

---

### Task 2: 配置、数据库连接与迁移

**Files:**
- Create: `apps/api/src/config/config.module.ts`、`config.service.ts`、`load-env.ts`
- Create: `apps/api/src/database/database.module.ts`、`database.service.ts`、`migrate.ts`
- Create: `apps/api/migrations/001_init.sql`
- Create: `apps/api/test/setup-env.ts`、`apps/api/test/utils/db.ts`、`apps/api/test/database.e2e-spec.ts`
- Modify: `apps/api/src/app.module.ts`、`health.controller.ts`、`health.module.ts`
- Modify: `apps/api/test/jest-e2e.json`

**Interfaces:**
- Produces: `ConfigService` 强类型 getter：`port`、`appOrigin`、`cookieSecure`、`db`、`llm`、`uploadDir`、`chunk`、`retrieval`、`workerConcurrency`
- Produces: `DatabaseService.query<T>(sql, params)`、`withTransaction<T>(fn)`
- Produces: `npm run db:migrate` 可重复执行；创建并迁移 `knowledge_rag_dev`（生产通过同一脚本使用 `knowledge_rag`）
- Produces: 数据库表与索引，供所有后续任务使用

- [ ] **Step 1: 写失败的数据库 e2e 测试**

```ts
// apps/api/test/database.e2e-spec.ts
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';

describe('database', () => {
  let app: INestApplication;
  let db: DatabaseService;
  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    db = app.get(DatabaseService);
  });
  afterAll(() => app.close());

  it('has vector extension and core tables', async () => {
    const ext = await db.query<{ extversion: string }>(
      "SELECT extversion FROM pg_extension WHERE extname = 'vector'",
    );
    expect(ext.rowCount).toBe(1);
    const tables = await db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public'",
    );
    const names = tables.rows.map((r) => r.table_name);
    expect(names).toEqual(expect.arrayContaining([
      'users', 'sessions', 'organizations', 'memberships', 'invites',
      'knowledge_bases', 'knowledge_base_members', 'documents', 'chunks',
      'conversations', 'messages',
    ]));
  });

  it('health reports db ok', async () => {
    const res = await request(app.getHttpServer()).get('/api/health').expect(200);
    expect(res.body.db).toBe('ok');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run db:migrate:test -w @knowledge-rag/api || true`（应因脚本不存在失败）
Run: `npm run test:e2e -w @knowledge-rag/api -- database`
Expected: FAIL，缺少 DatabaseModule/表。

- [ ] **Step 3: 实现配置与数据库**

`config.module.ts` 使用 `ConfigModule.forRoot({ isGlobal: true, envFilePath: [join(process.cwd(), '.env'), join(process.cwd(), '../../.env')] })`。`load-env.ts` 供迁移脚本使用（不依赖 Nest）：

```ts
import { loadEnvFile } from 'node:process';
import { join } from 'node:path';

try { loadEnvFile(join(process.cwd(), '.env')); } catch {}
try { loadEnvFile(join(process.cwd(), '../../.env')); } catch {}

export function loadConfig() {
  const required = (key: string) => {
    const value = process.env[key];
    if (!value) throw new Error(`Missing required env ${key}`);
    return value;
  };
  return {
    db: {
      host: required('DB_HOST'),
      port: Number(process.env.DB_PORT ?? 5432),
      user: required('DB_USER'),
      password: required('DB_PASSWORD'),
      database: required('DB_NAME'),
      ssl: process.env.DB_SSL === 'true',
    },
  };
}
```

`test/setup-env.ts` 由 Jest 在测试导入前执行：

```ts
process.env.NODE_ENV = 'test';
process.env.DB_NAME = process.env.DB_NAME || 'knowledge_rag_test';
process.env.APP_ORIGIN = 'http://localhost:5173';
process.env.BCRYPT_ROUNDS = '4';
process.env.UPLOAD_DIR = './test/tmp-uploads';
```

`test/utils/db.ts`：

```ts
export async function resetDatabase(db: DatabaseService) {
  await db.query(`TRUNCATE messages, conversations, chunks, documents,
    knowledge_base_members, knowledge_bases, invites, memberships,
    organizations, sessions, users CASCADE`);
}
```

`test/jest-e2e.json` 必须包含 `setupFiles: ["<rootDir>/test/setup-env.ts"]`、`testRegex: ".e2e-spec.ts$"`、`testEnvironment: "node"`。

健康检查在 Task 2 扩展为：

```ts
@Controller('health')
export class HealthController {
  constructor(private readonly db: DatabaseService) {}
  @Get()
  async check() {
    await this.db.query('SELECT 1');
    return { status: 'ok', db: 'ok' };
  }
}
```

`config.service.ts` 使用 `ConfigService` 读取并校验必填项（缺失时在启动期抛出）。关键 getter：

```ts
get db() {
  return {
    host: this.env.getOrThrow('DB_HOST'),
    port: Number(this.env.get('DB_PORT') ?? 5432),
    user: this.env.getOrThrow('DB_USER'),
    password: this.env.getOrThrow('DB_PASSWORD'),
    database: this.env.getOrThrow('DB_NAME'),
    ssl: this.env.get('DB_SSL') === 'true',
  };
}
get appOrigin() { return this.env.getOrThrow('APP_ORIGIN'); }
get bcryptRounds() { return Number(this.env.get('BCRYPT_ROUNDS') ?? 12); }
get uploadDir() { return this.env.get('UPLOAD_DIR') ?? './storage'; }
get chunkSize() { return Number(this.env.get('CHUNK_SIZE') ?? 800); }
get chunkOverlap() { return Number(this.env.get('CHUNK_OVERLAP') ?? 120); }
```

`DatabaseService`：

```ts
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly pool: Pool;
  constructor(config: AppConfigService) {
    this.pool = new Pool({ ...config.db, max: 10 });
  }
  query<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []) {
    return this.pool.query<T>(text, params);
  }
  async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  onModuleDestroy() { return this.pool.end(); }
}
```

`migrate.ts`：

```ts
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from 'pg';
import { loadConfig } from '../config/load-env';

const IDENT = /^[a-z_][a-z0-9_]*$/;

async function ensureDatabase(cfg: Config) {
  if (!IDENT.test(cfg.db.database)) throw new Error('invalid DB_NAME');
  const admin = new Client({ ...cfg.db, database: 'postgres' });
  await admin.connect();
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [cfg.db.database]);
    if (!exists.rowCount) {
      await admin.query(`CREATE DATABASE "${cfg.db.database}"`);
    }
  } finally {
    await admin.end();
  }
}

async function runMigrations() {
  const cfg = loadConfig();
  await ensureDatabase(cfg);
  const client = new Client({ ...cfg.db, database: cfg.db.database });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', ['knowledge_rag_migrations']);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const dir = process.env.MIGRATIONS_DIR ?? join(process.cwd(), 'migrations');
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const applied = await client.query('SELECT 1 FROM schema_migrations WHERE version=$1', [file]);
      if (applied.rowCount) continue;
      const sql = await readFile(join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', ['knowledge_rag_migrations']);
    await client.end();
  }
}

runMigrations().catch((e) => { console.error(e); process.exit(1); });
```

`001_init.sql` 必须完整创建以下表与索引：

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  password_hash text NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email));

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','admin','member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);
CREATE INDEX IF NOT EXISTS memberships_user_idx ON memberships(user_id);

CREATE TABLE IF NOT EXISTS invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  role text NOT NULL CHECK (role IN ('admin','member')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invites_org_idx ON invites(org_id);

CREATE TABLE IF NOT EXISTS knowledge_bases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  access_mode text NOT NULL DEFAULT 'org' CHECK (access_mode IN ('org','restricted')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS knowledge_bases_org_idx ON knowledge_bases(org_id);

CREATE TABLE IF NOT EXISTS knowledge_base_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kb_id uuid NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission text NOT NULL CHECK (permission IN ('viewer','editor','manager')),
  granted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kb_id, user_id)
);
CREATE INDEX IF NOT EXISTS kb_members_user_idx ON knowledge_base_members(user_id);

CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kb_id uuid NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  uploaded_by uuid REFERENCES users(id) ON DELETE SET NULL,
  filename text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL,
  storage_key text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','ready','failed')),
  error text,
  chunk_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS documents_kb_status_idx ON documents(kb_id, status);
CREATE INDEX IF NOT EXISTS documents_org_idx ON documents(org_id);

CREATE TABLE IF NOT EXISTS chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kb_id uuid NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL,
  content text NOT NULL,
  embedding vector(1024) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chunks_kb_idx ON chunks(org_id, kb_id);
CREATE INDEX IF NOT EXISTS chunks_document_idx ON chunks(document_id);
CREATE INDEX IF NOT EXISTS chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kb_id uuid NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversations_user_kb_idx ON conversations(user_id, kb_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user','assistant')),
  content text NOT NULL,
  sources jsonb,
  interrupted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id, created_at);
```

`start:worker:dev` 在 Task 7 才会用到；先保留脚本即可。

- [ ] **Step 4: 执行迁移并运行测试**

Run: `npm run db:migrate:test -w @knowledge-rag/api`
Expected: 创建/复用 `knowledge_rag_test`，迁移成功。
Run: `npm run test:e2e -w @knowledge-rag/api -- database`
Expected: PASS。

- [ ] **Step 5: 初始化开发库 + 追加本地 env**

Run: `npm run db:migrate -w @knowledge-rag/api`
Expected: 创建 `knowledge_rag_dev`。
在 `.env` 追加（保留现有值，将 `DB_NAME` 改为 `knowledge_rag_dev`）：

```dotenv
DB_NAME=knowledge_rag_dev
DB_SSL=false
APP_ORIGIN=http://localhost:5173
COOKIE_SECURE=false
REGISTRATION_ENABLED=true
EMBEDDING_MODEL=BAAI/bge-m3
EMBEDDING_DIMENSIONS=1024
UPLOAD_DIR=./storage
MAX_UPLOAD_MB=20
CHUNK_SIZE=800
CHUNK_OVERLAP=120
RETRIEVAL_TOP_K=6
RETRIEVAL_MIN_SCORE=0.2
SESSION_TTL_DAYS=7
WORKER_CONCURRENCY=1
```

- [ ] **Step 6: 类型检查**

Run: `npm run typecheck -w @knowledge-rag/api`
Expected: 0。

---

### Task 3: 认证、Session 与安全中间件

**Files:**
- Create: `apps/api/src/auth/{auth.module,auth.controller,auth.service,session.service,password.service}.ts`
- Create: `apps/api/src/auth/dto/{register,login,change-password}.dto.ts`
- Create: `apps/api/src/database/repositories/{users,sessions,organizations,memberships,invites}.repository.ts`
- Create: `apps/api/src/common/decorators/public.decorator.ts`、`current-user.decorator.ts`
- Create: `apps/api/src/common/guards/auth.guard.ts`
- Create: `apps/api/src/common/middleware/origin.middleware.ts`
- Create: `apps/api/src/common/filters/all-exceptions.filter.ts`
- Create: `apps/api/test/auth.e2e-spec.ts`、`apps/api/src/auth/password.service.spec.ts`
- Modify: `app.module.ts`、`main.ts`、`test/setup-env.ts`

**Interfaces:**
- Produces: `POST /api/auth/register`、`POST /api/auth/login`、`POST /api/auth/logout`、`GET /api/auth/me`、`POST /api/auth/password`
- Produces: 全局 `AuthGuard` + `@Public()`；`@CurrentUser()` 返回 `{id,email,name}`
- Produces: Cookie `kr_session`（httpOnly, SameSite=Lax, 7d）
- Produces: `SessionService.verify(rawToken): Promise<AuthUser | null>`、`SessionsRepository`
- Consumes: `DatabaseService`、`ConfigService`

- [ ] **Step 1: 写失败测试**

```ts
// apps/api/src/auth/password.service.spec.ts
import { PasswordService } from './password.service';

describe('PasswordService', () => {
  const svc = new PasswordService({ bcryptRounds: 4 } as never);
  it('hashes and verifies', async () => {
    const hash = await svc.hash('correct horse');
    expect(hash).not.toBe('correct horse');
    await expect(svc.verify('correct horse', hash)).resolves.toBe(true);
    await expect(svc.verify('wrong', hash)).resolves.toBe(false);
  });
});
```

```ts
// apps/api/test/auth.e2e-spec.ts
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/create-app';

describe('auth', () => {
  let app: INestApplication;
  beforeAll(async () => { app = await createTestApp(); });
  afterAll(() => app.close());

  it('registers, returns me and logs out', async () => {
    const agent = request.agent(app.getHttpServer());
    const email = `owner-${Date.now()}@test.local`;
    await agent.post('/api/auth/register').send({
      name: 'Owner', email, password: 'password123', orgName: 'Acme',
    }).expect(201).expect((res) => {
      expect(res.body.user.email).toBe(email);
      expect(res.body.organizations[0].role).toBe('owner');
    });
    await agent.get('/api/auth/me').expect(200).expect((res) => {
      expect(res.body.user.email).toBe(email);
    });
    await agent.post('/api/auth/logout').expect(200);
    await agent.get('/api/auth/me').expect(401);
  });

  it('rejects bad origin on writes', async () => {
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('Origin', 'http://evil.example')
      .send({ email: 'x@test.local', password: 'password123' })
      .expect(403);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run test -w @knowledge-rag/api -- password.service`
Run: `npm run test:e2e -w @knowledge-rag/api -- auth`
Expected: FAIL（缺少模块/路由）。

- [ ] **Step 3: 实现认证**

关键实现约束：

```ts
// password.service.ts
import bcrypt from 'bcryptjs';
import { AppConfigService } from '../config/config.service';

@Injectable()
export class PasswordService {
  constructor(private readonly config: AppConfigService) {}
  hash(plain: string) { return bcrypt.hash(plain, this.config.bcryptRounds); }
  verify(plain: string, hash: string) { return bcrypt.compare(plain, hash); }
}
```

```ts
// session.service.ts（核心逻辑）
const raw = randomBytes(32).toString('base64url');
const tokenHash = createHash('sha256').update(raw).digest('hex');
await repo.create({ userId, tokenHash, expiresAt: addDays(new Date(), 7) });
// Set-Cookie: kr_session=${raw}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800[; Secure]
```

- `AuthGuard` 从 `req.cookies.kr_session` 读取，Hash 后查 sessions 与 users；校验过期并更新 `last_used_at`；失败抛 401。`@Public()` 使用 Reflector 跳过。
- `OriginMiddleware`：`GET/HEAD/OPTIONS` 跳过；有 `Origin` 且不等于 `APP_ORIGIN` 返回 403；无 Origin 允许（测试/命令行）。
- `AuthService.register` 使用 `DatabaseService.withTransaction`：
  - 有 `inviteToken`：按 sha256 查找未过期未使用邀请；创建用户；插入 membership（邀请角色）；更新邀请 accepted；创建 session。
  - 无邀请：要求 `orgName`；创建用户、组织（created_by=user）、owner membership、session。
  - 邮箱先 trim + lowercase 查重；冲突返回 409。
- 登录失败统一 401 “邮箱或密码错误”。
- 修改密码：校验当前密码；更新 hash；删除其他 session。
- `ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }])`；登录 `5/min`、注册 `10/hour`、邀请查询 `30/min`。
- 全局注册 `AuthGuard`（APP_GUARD）、`AllExceptionsFilter`，main 中启用 `OriginMiddleware`。
- `register`/`login`/`GET /invites/:token`/`health` 标记 `@Public()`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test -w @knowledge-rag/api -- password.service`
Run: `npm run test:e2e -w @knowledge-rag/api -- auth`
Expected: PASS。

- [ ] **Step 5: 类型检查**

Run: `npm run typecheck -w @knowledge-rag/api`
Expected: 0。

---

### Task 4: 组织、成员与邀请

**Files:**
- Create: `apps/api/src/organizations/{organizations.module,organizations.controller,organizations.service,members.service,invites.service}.ts`
- Create: `apps/api/src/organizations/dto/*.ts`
- Create: `apps/api/src/common/guards/org-member.guard.ts`
- Create: `apps/api/src/common/decorators/current-membership.decorator.ts`
- Create: `apps/api/src/common/events/access-events.service.ts`
- Create: `apps/api/test/organizations.e2e-spec.ts`
- Modify: `auth.service.ts` 复用 Task 3 已创建的邀请/组织 repository

**Interfaces:**
- Produces: 组织/成员/邀请 REST 接口（路径见 spec §9.3）
- Produces: `OrgMemberGuard` 将 `membership {orgId,userId,role}` 挂到 request
- Produces: `AccessEventsService.emit({userIds,kbId,reason})`；后续实时模块订阅
- Produces: 邀请 token 明文只在创建响应中出现一次，数据库仅存 SHA-256

- [ ] **Step 1: 写失败的邀请/角色测试**

```ts
it('invites a member and enforces roles', async () => {
  const owner = request.agent(app.getHttpServer());
  const org = await owner.post('/api/auth/register').send({
    name: 'Owner', email: `o-${Date.now()}@test.local`, password: 'password123', orgName: 'Team',
  }).expect(201);
  const orgId = org.body.organizations[0].id;

  const invite = await owner.post(`/api/orgs/${orgId}/invites`)
    .send({ role: 'member' }).expect(201);
  expect(invite.body.token).toBeTruthy();

  const member = request.agent(app.getHttpServer());
  const joined = await member.post('/api/auth/register').send({
    name: 'Member', email: `m-${Date.now()}@test.local`, password: 'password123',
    inviteToken: invite.body.token,
  }).expect(201);
  expect(joined.body.organizations[0].role).toBe('member');

  await member.patch(`/api/orgs/${orgId}/members/${joined.body.user.id}`)
    .send({ role: 'admin' }).expect(403);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run test:e2e -w @knowledge-rag/api -- organizations`
Expected: FAIL（路由不存在）。

- [ ] **Step 3: 实现组织与邀请**

- 路由：`POST /orgs`、`PATCH /orgs/:orgId`、`GET /orgs/:orgId/members`、`PATCH/DELETE /orgs/:orgId/members/:userId`、`GET/POST /orgs/:orgId/invites`、`DELETE /orgs/:orgId/invites/:inviteId`、`GET /invites/:token`、`POST /invites/:token/accept`。
- 修改组织名仅 Owner。
- 成员角色修改仅 Owner；目标不能是 owner；只能设 admin/member。
- 删除成员：Owner 可删 admin/member；Admin 只能删 member；不能删自己或 owner。事务内删除 membership、该用户在本组织的 `knowledge_base_members`、`conversations`；返回受影响 KB ids，逐个调用 `AccessEventsService.emit({ userIds:[userId], kbId, reason:'org-member-removed' })`。
- 邀请：Owner 可创建 admin/member；Admin 只能 member；有效 7 天；列表不返回 token；撤销用 DELETE。接受邀请需登录；已是成员返回 409；过期/已用返回 410/409。
- `GET /invites/:token` 公开，只返回 orgName、role、valid、expiresAt。
- `POST /orgs` 任意登录用户创建新组织并成为 owner。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test:e2e -w @knowledge-rag/api -- organizations`
Expected: PASS。

- [ ] **Step 5: 类型检查**

Run: `npm run typecheck -w @knowledge-rag/api`
Expected: 0。

---

## Phase 1 — 知识库、文档与队列

### Task 5: 知识库 CRUD 与三级 ACL

**Files:**
- Create: `apps/api/src/knowledge-bases/{knowledge-bases.module,knowledge-bases.controller,knowledge-bases.service,kb-access.service,kb-members.service}.ts`
- Create: `apps/api/src/knowledge-bases/dto/*.ts`
- Create: `apps/api/src/database/repositories/{knowledge-bases,kb-members,kb-access}.repository.ts`
- Create: `apps/api/src/common/decorators/require-kb-permission.decorator.ts`
- Create: `apps/api/src/common/guards/kb-permission.guard.ts`
- Create: `apps/api/test/knowledge-bases.e2e-spec.ts`
- Create: `apps/api/src/knowledge-bases/kb-access.service.spec.ts`

**Interfaces:**
- Produces: `KbAccessService.resolve(userId, orgId, kbId): Promise<'viewer'|'editor'|'manager'|null>`
- Produces: `@RequireKbPermission('viewer'|'editor'|'manager')` 与 `KbPermissionGuard`；request 挂 `kbPermission`
- Produces: 知识库与 KB 成员 REST 接口（spec §9.4）
- Consumes: `OrgMemberGuard`、`AccessEventsService`、Database repositories；`KbAccessRepository` 提供 `getOrgRole`、`getKb`、`getMemberPermission`

- [ ] **Step 1: 写权限矩阵单元测试**

```ts
describe('KbAccessService effective permission', () => {
  it.each([
    ['owner', null, null, 'org', 'manager'],
    ['admin', null, null, 'restricted', 'manager'],
    ['member', null, null, 'org', 'viewer'],
    ['member', 'editor', null, 'restricted', 'editor'],
    ['member', 'manager', 'creator', 'restricted', 'manager'],
    ['member', null, null, 'restricted', null],
  ])('orgRole=%s explicit=%s creator=%s mode=%s => %s', async (orgRole, explicit, creator, mode, expected) => {
    const repo = {
      getOrgRole: jest.fn().mockResolvedValue(orgRole),
      getKb: jest.fn().mockResolvedValue({ id: 'kb', orgId: 'org', createdBy: creator ? 'user' : 'other', accessMode: mode }),
      getMemberPermission: jest.fn().mockResolvedValue(explicit),
    };
    const svc = new KbAccessService(repo as never);
    await expect(svc.resolve('user', 'org', 'kb')).resolves.toBe(expected);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run test -w @knowledge-rag/api -- kb-access.service`
Expected: FAIL（类不存在）。

- [ ] **Step 3: 实现 ACL 与 CRUD**

- 有效权限按 spec §8.2：Owner/Admin → manager；creator → manager；显式权限；`access_mode='org'` 且为组织成员 → viewer；否则 null。
- `KbPermissionGuard` 从 `params.kbId` 读取；未登录 401；无权限 404（隐藏存在性）；权限不足 403。
- 列表：Owner/Admin 返回该组织全部 KB；普通成员返回 `access_mode='org' OR created_by=me OR 显式授权` 的 KB，并返回 effectivePermission、documentCount、memberCount。
- 创建：任意组织成员；`accessMode` 默认 `org`；创建者为 manager。
- 更新名称/描述/accessMode：KB manager；accessMode 从 `org` 改为 `restricted` 时，找出失去隐式 viewer 的组织成员（排除 owner/admin/creator/显式成员），逐个 emit 撤销事件。
- 删除接口在 Task 6 实现（需要 `StorageService.removeKbDir`），Task 5 只实现列表/创建/更新/成员管理。
- KB 成员管理：仅 KB manager；目标必须是组织成员；不能添加 owner/admin（隐式）；不能修改/删除 creator；删除显式成员或改为无权限时 emit 撤销事件。
- 所有接口先过 `OrgMemberGuard`；所有 SQL 带 `org_id`。

- [ ] **Step 4: 写并通过 e2e**

测试覆盖：创建 KB、受限库不可见、授权 viewer 可见、viewer 不可上传（后续上传接口返回 403）、manager 管理成员、非组织成员 404、管理员穿透。

Run: `npm run test:e2e -w @knowledge-rag/api -- knowledge-bases`
Expected: PASS。

- [ ] **Step 5: 类型检查**

Run: `npm run typecheck -w @knowledge-rag/api`
Expected: 0。

---

### Task 6: 原文件存储与文档 API

**Files:**
- Create: `apps/api/src/storage/{storage.module,storage.service}.ts`
- Create: `apps/api/src/documents/{documents.module,documents.controller,documents.service,document-validation}.ts`
- Create: `apps/api/src/documents/dto/*.ts`
- Create: `apps/api/src/database/repositories/documents.repository.ts`
- Create: `apps/api/src/storage/storage.service.spec.ts`
- Create: `apps/api/test/documents.e2e-spec.ts`
- Modify: `knowledge-bases.service.ts` 调用 `StorageService.removeKbDir`

**Interfaces:**
- Produces: `StorageService.save({orgId,kbId,documentId,filename,buffer})` → `{storageKey,sizeBytes}`
- Produces: `StorageService.resolve(storageKey)`、`removeFile`、`removeDocumentDir`、`removeKbDir`
- Produces: `GET/POST /orgs/:orgId/knowledge-bases/:kbId/documents`、`GET /orgs/:orgId/documents/:id/download`、`DELETE /orgs/:orgId/documents/:id`
- Produces: `DELETE /orgs/:orgId/knowledge-bases/:kbId`（creator 或 Owner/Admin；删除 KB 目录并级联数据库）
- Produces: 文档对象字段：`id,orgId,kbId,filename,mimeType,sizeBytes,status,error,chunkCount,createdAt`

- [ ] **Step 1: 写失败的存储安全与上传测试**

```ts
it('rejects path traversal and writes under upload root', async () => {
  const svc = new StorageService({ uploadDir: tmpDir } as never);
  const saved = await svc.save({ orgId: 'o', kbId: 'k', documentId: 'd', filename: '../../evil.txt', buffer: Buffer.from('hi') });
  expect(saved.storageKey).toContain('evil.txt');
  expect(saved.storageKey.includes('..')).toBe(false);
});

it('uploads, downloads and hides from other org', async () => {
  // 创建 owner、KB；上传 notes.txt（editor 由 creator 隐式拥有）
  const upload = await owner.post(`/api/orgs/${orgId}/knowledge-bases/${kbId}/documents`)
    .attach('file', Buffer.from('hello knowledge'), 'notes.txt').expect(201);
  expect(upload.body.status).toBe('queued');
  const dl = await owner.get(`/api/orgs/${orgId}/documents/${upload.body.id}/download`).expect(200);
  expect(dl.text).toBe('hello knowledge');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run test -w @knowledge-rag/api -- storage.service`
Run: `npm run test:e2e -w @knowledge-rag/api -- documents`
Expected: FAIL。

- [ ] **Step 3: 实现存储与文档接口**

- 本任务允许扩展名：`.txt`、`.md`；Task 8 扩展 `.pdf`、`.docx`。本任务 e2e 只用 txt/md。
- 上传使用 `FileInterceptor('file', { limits: { fileSize: maxUploadMb * 1024 * 1024 } })`（内存存储）。
- 校验扩展名 + MIME 白名单 + 魔数：PDF `%PDF-`，DOCX `PK\x03\x04`；TXT/MD 允许 `text/plain`/`text/markdown`。
- 文件名清洗：`basename`、去控制字符、去 `..`、长度 ≤ 200，空则 `document`。
- 存储路径：`orgs/{orgId}/knowledge-bases/{kbId}/documents/{documentId}/{filename}`；`resolve` 后必须以 `UPLOAD_DIR` 绝对路径开头，否则抛 400。
- 上传流程：校验 → `documentId=randomUUID()` → 写文件 → 插入文档（queued）→（Task 7 起）入队。入队失败则标记 failed 并抛 503。
- 下载：viewer+；文件不存在 404；使用 `res.download(absPath, filename)`。
- 删除：editor+；先删数据库记录（级联 chunks），再删文档目录；删除 KB 时递归删除 KB 目录。
- 实现 `DELETE /orgs/:orgId/knowledge-bases/:kbId`：仅 creator 或组织 Owner/Admin；先读取存储目录，删除数据库记录，再 `StorageService.removeKbDir(orgId,kbId)`；测试覆盖无权限 403 与文件清理。
- e2e 覆盖：上传/列表/下载/删除、错误 MIME、路径穿越文件名、另一个组织用户 404。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test -w @knowledge-rag/api -- storage.service`
Run: `npm run test:e2e -w @knowledge-rag/api -- documents`
Expected: PASS。

- [ ] **Step 5: 类型检查**

Run: `npm run typecheck -w @knowledge-rag/api`
Expected: 0。

---

### Task 7: pg-boss、TXT/MD 入库与 Worker

**Files:**
- Create: `apps/api/src/queue/{queue.module,queue.service,queue.constants}.ts`
- Create: `apps/api/src/llm/{llm.module,llm.service,llm.errors,sse-parser}.ts`
- Create: `apps/api/src/ingestion/{ingestion.module,ingestion.service,ingestion.processor}.ts`
- Create: `apps/api/src/ingestion/parsing/{normalize,chunker,parser.service,text.parser}.ts`
- Create: `apps/api/src/worker.ts`、`worker.module.ts`
- Create: `apps/api/src/ingestion/parsing/chunker.spec.ts`
- Create: `apps/api/src/ingestion/ingestion.service.spec.ts`
- Create: `apps/api/src/llm/sse-parser.spec.ts`
- Create: `apps/api/test/utils/fakes.ts`（FakeLlmService、临时上传目录）
- Modify: `documents.service.ts`（入队/重试）、`documents.controller.ts`（retry）、`app.module.ts`

**Interfaces:**
- Produces: `QueueService.enqueueDocument(payload)`、`QueueService.work(handler)`、`QueueService.health(): Promise<'ok'|'down'>`；任务名 `document.ingest`
- Produces: `LlmService.embed(inputs: string[], signal?): Promise<number[][]>`；批大小 16，429/5xx 重试 3 次
- Produces: `LlmService.streamChat(messages, signal): AsyncGenerator<string>`（Task 9 使用）
- Produces: `IngestionService.process(payload)`：解析、切分、embedding、事务写入 chunks、更新状态、`pg_notify`
- Produces: Worker 独立进程 `node dist/worker.js`
- Consumes: `DocumentsRepository`、`StorageService`、`DatabaseService`、`AppConfigService`

- [ ] **Step 1: 写失败的切分与入库测试**

```ts
describe('chunkText', () => {
  it('keeps overlap and respects size', () => {
    const text = Array.from({ length: 30 }, (_, i) => `第${i}段。`).join('\n\n');
    const chunks = chunkText(text, 60, 10);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(70);
    expect(chunks[1].slice(0, 5)).toBe(chunks[0].slice(-5));
  });
  it('returns [] for blank text', () => expect(chunkText(' \n ')).toEqual([]));
});
```

```ts
it('ingests a text file and writes chunks', async () => {
  const db = await createTestDb();
  const doc = await db.insertDocumentFixture({ filename: 'a.txt', content: 'hello world' });
  const fakeLlm = { embed: jest.fn(async (xs: string[]) => xs.map(() => Array(1024).fill(0.01))) };
  const svc = new IngestionService(db as never, storage as never, parser as never, fakeLlm as never, config as never);
  await svc.process({ documentId: doc.id, orgId: doc.orgId, kbId: doc.kbId, uploadedBy: doc.uploadedBy });
  const row = await db.query("SELECT status,chunk_count FROM documents WHERE id=$1", [doc.id]);
  expect(row.rows[0]).toMatchObject({ status: 'ready', chunk_count: 1 });
  const chunks = await db.query('SELECT content FROM chunks WHERE document_id=$1', [doc.id]);
  expect(chunks.rowCount).toBe(1);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run test -w @knowledge-rag/api -- chunker`
Expected: FAIL。

- [ ] **Step 3: 实现队列、LLM embedding、解析与 Worker**

`QueueService` 关键代码（按 pg-boss 11 CJS API）：

```ts
const boss = new PgBoss({ connectionString, schema: 'pgboss', max: 5 });
boss.on('error', (e) => this.logger.error(e.message));
await boss.start();
this.started = true;
await boss.createQueue(DOCUMENT_QUEUE, {
  retryLimit: 2, retryDelay: 15, retryBackoff: true, expireInMinutes: 30,
});
// enqueue
await boss.send(DOCUMENT_QUEUE, payload, { singletonKey: `ingest-${documentId}-${Date.now()}` });
// worker
// pg-boss 11: register one worker per configured concurrency slot
for (let i = 0; i < config.workerConcurrency; i += 1) {
  await boss.work(DOCUMENT_QUEUE, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) await handler(job.data as IngestJob);
  });
}
```

`normalize`：CRLF→LF、去 NUL、合并 3+ 空行、trim。TXT/MD 解码：UTF-8 `TextDecoder('utf-8',{fatal:true})`，失败用 `iconv-lite` GB18030。

`chunker.ts` 使用段落/换行/句号边界，800 字符、120 重叠；空内容返回 `[]`。

`IngestionService.process`：
1. 查文档；不存在直接返回。
2. 状态 `processing`，清 error，`pg_notify` 状态。
3. 读文件 → 解析 → 切分；空内容抛错。
4. 批量 16 条 embedding。
5. 事务：`DELETE FROM chunks WHERE document_id=$1`；逐条 INSERT `vector`；更新文档 `ready, chunk_count`；提交。
6. `pg_notify('kr_document_status', JSON.stringify(payload))`。
7. 捕获错误：更新 `failed, error=truncate(message,500)`，notify，重新抛出以触发 pg-boss 重试。

`LlmService.embed` 调用 `POST {BASE_URL}/embeddings`，body `{model: EMBEDDING_MODEL, input: batch}`；校验返回维度 1024；错误重试 3 次（指数退避 1s/2s/4s），超时 60s。

Worker：

```ts
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
}
void bootstrap();
```

`QueueService.onModuleDestroy` 调 `boss.stop()`；`worker.module.ts` 只导入 Config、Database、Storage、Llm、Queue、Ingestion。

文档上传后调用 `queue.enqueueDocument({ documentId, orgId, kbId, uploadedBy })`；新增 `POST /orgs/:orgId/documents/:id/retry`（editor+，仅 failed/ready 可重试；置 queued、清 error、入队）。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test -w @knowledge-rag/api -- chunker`
Run: `npm run test -w @knowledge-rag/api -- ingestion.service`
Run: `npm run test -w @knowledge-rag/api -- sse-parser`
Expected: PASS。

- [ ] **Step 5: 本地队列手动验证**

启动 `npm run dev:api` 与 `npm run dev:worker`，账号上传一个 txt，观察文档从 queued → processing → ready，并确认 `chunks` 有数据、`documents.chunk_count` 正确。失败则检查 worker 日志。

- [ ] **Step 6: 类型检查**

Run: `npm run typecheck -w @knowledge-rag/api`
Expected: 0。

---

### Task 8: PDF / DOCX 解析

**Files:**
- Create: `apps/api/src/ingestion/parsing/pdf.parser.ts`、`docx.parser.ts`
- Create: `apps/api/src/ingestion/parsing/parsers.spec.ts`
- Create: `apps/api/test/fixtures/make-fixtures.ts`
- Modify: `parser.service.ts`、`document-validation.ts`、`documents.e2e-spec.ts`

**Interfaces:**
- Produces: `ParserService.parse(storageKey, mimeType): Promise<string>`，按扩展名分派
- Produces: PDF 解析使用 `PDFParse` v2；DOCX 使用 `mammoth.extractRawText`
- Produces: 解析超时 60s；PDF 页数上限 200；无文本 PDF 抛 `BadRequestException('PDF 未包含可提取文本，可能是扫描件')`

- [ ] **Step 1: 写失败的 PDF/DOCX 测试**

```ts
it('extracts text from generated pdf and docx', async () => {
  const pdfPath = await makePdfFixture('Knowledge base PDF content');
  const docxPath = await makeDocxFixture('Knowledge base DOCX content');
  await expect(new PdfParser().parseFile(pdfPath)).resolves.toContain('Knowledge base PDF content');
  await expect(new DocxParser().parseFile(docxPath)).resolves.toContain('Knowledge base DOCX content');
});
it('rejects a pdf with no text', async () => {
  const blank = await makeBlankPdfFixture();
  await expect(new PdfParser().parseFile(blank)).rejects.toThrow(/未包含可提取文本/);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run test -w @knowledge-rag/api -- parsers`
Expected: FAIL。

- [ ] **Step 3: 实现解析器**

PDF（pdf-parse v2）：

```ts
const parser = new PDFParse({ data: buffer });
try {
  const info = await parser.getInfo();
  if (info.total > 200) throw new BadRequestException('PDF 页数超过 200 页');
  const result = await parser.getText();
  return result.text;
} finally {
  await parser.destroy();
}
```

用 60 秒 `Promise.race` 包裹；文本 trim 后长度 < 20 抛“未包含可提取文本”。
DOCX：

```ts
const { value } = await mammoth.extractRawText({ buffer });
return value.trim();
```

- 更新文档校验：允许 `.pdf`/`.docx` 与对应 MIME/魔数。
- 测试生成 fixture 用 devDependencies `pdfkit` 与 `docx`；不得提交二进制文件。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test -w @knowledge-rag/api -- parsers`
Run: `npm run test:e2e -w @knowledge-rag/api -- documents`
Expected: PASS。

- [ ] **Step 5: 类型检查**

Run: `npm run typecheck -w @knowledge-rag/api`
Expected: 0。

---

### Task 9: 检索、提示词与会话服务

**Files:**
- Create: `apps/api/src/chat/{chat.module,chat.service,retrieval.service,prompt.service,sources.ts}.ts`
- Create: `apps/api/src/database/repositories/{conversations,messages,chunks}.repository.ts`
- Create: `apps/api/src/chat/{prompt.service.spec.ts,chat.service.spec.ts,retrieval.service.spec.ts}`
- Create: `apps/api/test/conversations.e2e-spec.ts`
- Modify: `llm.service.ts`（streamChat 完整实现）、`worker?`（无）
- Create: `apps/api/src/chat/chat.controller.ts`（会话历史 REST，聊天仅 WS）

**Interfaces:**
- Produces: `RetrievalService.retrieve(orgId,kbId,question,limit,minScore): Promise<Source[]>`
- Produces: `PromptService.build(history, sources, question): ChatMessage[]`
- Produces: `ChatService.run({user,orgId,kbId,conversationId,question,signal,onMeta,onDelta}): Promise<ChatResult>`
- Produces: `ChatResult = { conversationId: string; assistantMessageId: string | null; answer: string; sources: Source[]; interrupted: boolean }`
- Produces: 会话 REST（spec §9.6）
- Produces: `LlmService.streamChat` 解析 OpenAI SSE，支持 AbortSignal

- [ ] **Step 1: 写失败的检索与提示词测试**

```ts
it('builds numbered sources and keeps history', () => {
  const messages = buildPrompt({
    history: [{ role: 'user', content: '之前的问题' }],
    sources: [
      { index: 1, filename: 'a.md', content: '片段 A', documentId: 'd1', chunkId: 'c1', chunkIndex: 0, score: 0.9 },
      { index: 2, filename: 'b.pdf', content: '片段 B', documentId: 'd2', chunkId: 'c2', chunkIndex: 1, score: 0.8 },
    ],
    question: '现在的问题',
  });
  expect(messages[0].role).toBe('system');
  expect(messages.at(-1)).toEqual({ role: 'user', content: '现在的问题' });
  expect(JSON.stringify(messages)).toContain('[1]');
  expect(JSON.stringify(messages)).toContain('a.md');
});
```

```ts
it('returns no sources and no llm call when nothing is relevant', async () => {
  const llm = { streamChat: jest.fn() };
  const conversations = {
    findOwned: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue({ id: 'c1' }),
    touch: jest.fn(),
  };
  const messages = {
    insertUser: jest.fn().mockResolvedValue({ id: 'u1' }),
    insertAssistant: jest.fn().mockResolvedValue({ id: 'a1' }),
    recent: jest.fn().mockResolvedValue([]),
  };
  const svc = new ChatService(
    conversations as never,
    messages as never,
    { retrieve: jest.fn().mockResolvedValue([]) } as never,
    llm as never,
    { retrievalTopK: 6, retrievalMinScore: 0.2 } as never,
  );
  const result = await svc.run({
    user: { id: 'u1' }, orgId: 'o1', kbId: 'k1', question: 'unknown',
    signal: new AbortController().signal, onMeta: jest.fn(), onDelta: jest.fn(),
  });
  expect(llm.streamChat).not.toHaveBeenCalled();
  expect(result.answer).toContain('知识库中没有找到足够的信息');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run test -w @knowledge-rag/api -- prompt.service`
Expected: FAIL。

- [ ] **Step 3: 实现检索与会话**

- 检索 SQL 使用 `1 - (embedding <=> $1::vector)`，过滤 `org_id`、`kb_id`、`documents.status='ready'`，Top 6、score ≥ 0.2；返回 Source（index 从 1 开始）。
- 无结果固定回答：`知识库中没有找到足够的信息，请尝试换一种问法或先上传相关资料。`；不调用 LLM；保存 assistant 消息。
- 会话：
  - 新会话标题 = 问题前 30 字符。
  - 插入 user 消息后再检索。
  - 历史取最近 6 条（不含当前问题）。
  - 成功插入 assistant 消息（content、sources、interrupted=false），更新 conversation.updated_at。
  - 取消/断线：保存已生成内容，`interrupted=true`；内容为空则不插入 assistant。
- `LlmService.streamChat`：`POST /chat/completions`，`stream:true`，解析 `data:` 行；忽略 `[DONE]`；解析失败抛出；支持 `AbortSignal`；60s idle timeout。
- 会话 REST：列表、创建、消息、删除；必须校验 KB viewer 且会话属于当前用户。
- 单测使用 fake LLM；集成测试插入 3 条已知向量验证排序。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test -w @knowledge-rag/api -- prompt.service`
Run: `npm run test -w @knowledge-rag/api -- retrieval.service`
Run: `npm run test -w @knowledge-rag/api -- chat.service`
Run: `npm run test:e2e -w @knowledge-rag/api -- conversations`
Expected: PASS。

- [ ] **Step 5: 类型检查**

Run: `npm run typecheck -w @knowledge-rag/api`
Expected: 0。

---

### Task 10: WebSocket、实时状态与权限撤销

**Files:**
- Create: `apps/api/src/realtime/{realtime.module,realtime.gateway,realtime.listener,realtime.service,socket-auth}.ts`
- Create: `apps/api/test/realtime.e2e-spec.ts`
- Modify: `app.module.ts`、`access-events.service.ts` 订阅、`health.controller.ts`（queue 状态）
- Modify: `organizations.service.ts` / `kb-members.service.ts`（调用 access events，前面已接）
- Modify: `package.json` 测试依赖 `socket.io-client`（devDependency）

**Interfaces:**
- Produces: Socket.IO Gateway（默认命名空间、`/socket.io` 路径）
- Produces: 事件 `kb:join`/`kb:leave`/`chat:send`/`chat:cancel` → `chat:meta`/`chat:delta`/`chat:done`/`chat:error`
- Produces: `document:status`、`kb:access-revoked`
- Consumes: `ChatService`、`KbAccessService`、`SessionService`、`AccessEventsService`、`ChatService`
- Produces: `RealtimeService.revokeKbAccess(userIds,kbId)`；PG LISTEN `kr_document_status`

- [ ] **Step 1: 写失败的 WebSocket 测试**

```ts
import { io, Socket } from 'socket.io-client';
it('rejects unauthenticated socket and allows cookie-authenticated join', async () => {
  const anon = io(`http://127.0.0.1:${port}`, { transports: ['websocket'], extraHeaders: { Origin: 'http://localhost:5173' } });
  await new Promise((resolve) => anon.on('connect_error', resolve));
  expect(anon.connected).toBe(false);
  anon.close();

  // owner agent 登录后取 cookie，连接时带 Cookie
  const socket: Socket = io(`http://127.0.0.1:${port}`, {
    transports: ['websocket'],
    extraHeaders: { Origin: 'http://localhost:5173', Cookie: cookie },
  });
  await new Promise((resolve) => socket.on('connect', resolve));
  const ack = await socket.emitWithAck('kb:join', { orgId, kbId });
  expect(ack).toMatchObject({ ok: true, permission: 'manager' });
  socket.close();
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run test:e2e -w @knowledge-rag/api -- realtime`
Expected: FAIL。

- [ ] **Step 3: 实现 Gateway 与监听器**

- 握手：解析 `kr_session` Cookie、校验 Origin（`APP_ORIGIN`）、`SessionService.verify`；失败 `socket.disconnect(true)`。
- 连接后加入 `user:{userId}`；24h 强制断开；每次 `kb:join`/`chat:send` 重新校验 Session 与 KB 权限。
- `kb:join`：校验 viewer；加入 `kb:{kbId}`；ack `{ok:true,permission}`；`kb:leave` 离开。
- `chat:send`：DTO 校验（question 1–2000、uuid）；单 socket 只允许一个进行中的请求；每用户 10 次/分钟；创建 AbortController；调用 `ChatService.run`，回调发 `chat:meta`/`chat:delta`；完成发 `chat:done`；异常发 `chat:error`；取消/断开时 abort 并保存部分内容。
- `chat:cancel`：按 requestId abort。
- `AccessEventsService.revocations$` 订阅：对每个 userId，`server.in('user:'+userId).socketsLeave('kb:'+kbId)`，并发送 `kb:access-revoked`。
- `RealtimeListenerService`：独立 `pg.Client` 连接，`LISTEN kr_document_status`；收到后调用 gateway.broadcastDocumentStatus，发到 `kb:{kbId}` 与 `user:{uploadedBy}`；断线 5s 重连。
- 健康检查加入 pg-boss 队列状态（`boss.getQueue` 或 `isStarted()`）；失败返回 503。
- 测试覆盖：匿名拒绝、跨组织不能 join、viewer 可 join、聊天事件顺序、取消、权限撤销后离开房间。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test:e2e -w @knowledge-rag/api -- realtime`
Expected: PASS。

- [ ] **Step 5: 全量后端验证**

Run: `npm run test -w @knowledge-rag/api && npm run test:e2e -w @knowledge-rag/api`
Expected: 全部 PASS。

---

## Phase 2 — 前端

### Task 11: Vite + React + Tailwind 基座与设计系统

**Files:**
- Create: `apps/web/package.json`、`vite.config.ts`、`tsconfig.json`、`tsconfig.app.json`、`tsconfig.node.json`、`index.html`
- Create: `apps/web/src/main.tsx`、`app/App.tsx`、`app/providers.tsx`、`app/router.tsx`
- Create: `apps/web/src/styles/index.css`
- Create: `apps/web/src/components/ui/{button,input,textarea,select,dialog,badge,spinner,empty-state,toast}.tsx`
- Create: `apps/web/src/lib/{cn.ts,api.ts,types.ts}`
- Create: `apps/web/src/lib/cn.spec.ts`
- Modify: root scripts

**Interfaces:**
- Produces: Vite dev server 5173，proxy `/api`、`/socket.io` → `http://localhost:3300`（ws:true）
- Produces: `apiFetch<T>(path, init?)`，`credentials:'include'`，401 抛 `ApiError(401)`
- Produces: UI 基础组件与主题 token
- Produces: `cn(...classes)` 合并类名

- [ ] **Step 1: 写失败的 `cn` 测试**

```ts
import { cn } from './cn';
it('merges conditional classes', () => {
  expect(cn('px-2', false && 'hidden', 'px-4')).toBe('px-4');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run test -w @knowledge-rag/web -- cn`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 创建前端基座**

`apps/web/package.json`：

```json
{
  "name": "@knowledge-rag/web",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@tanstack/react-query": "^5.104.5",
    "clsx": "^2.1.1",
    "lucide-react": "^1.61.0",
    "react": "^19.3.1",
    "react-dom": "^19.3.1",
    "react-markdown": "^10.1.0",
    "react-router-dom": "^7.18.4",
    "remark-gfm": "^4.0.1",
    "socket.io-client": "^4.8.4",
    "tailwind-merge": "^3.7.0"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.3.3",
    "@testing-library/jest-dom": "^6.8.0",
    "@testing-library/react": "^16.3.3",
    "@types/react": "^19.2.0",
    "@types/react-dom": "^19.2.0",
    "@vitejs/plugin-react": "^6.1.2",
    "jsdom": "^30.1.3",
    "tailwindcss": "^4.3.3",
    "typescript": "^5.9.2",
    "vite": "^8.3.5",
    "vitest": "^5.0.5"
  }
}
```

`vite.config.ts`：

```ts
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3300', changeOrigin: false },
      '/socket.io': { target: 'http://localhost:3300', ws: true, changeOrigin: false },
    },
  },
});
```

`src/styles/index.css`：

```css
@import "tailwindcss";
@theme {
  --color-canvas: #f6f5f2;
  --color-ink: #1d2430;
  --color-muted: #667085;
  --color-accent: #4f46e5;
  --color-accent-dark: #4338ca;
  --color-sidebar: #111827;
  --color-line: #e5e2dc;
  --font-sans: "Inter", "PingFang SC", "Microsoft YaHei", sans-serif;
}
```

`api.ts`：

```ts
export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: { ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...init.headers },
  });
  if (!res.ok) {
    let message = `请求失败 (${res.status})`;
    try { const data = await res.json(); message = Array.isArray(data.message) ? data.message.join('；') : data.message ?? message; } catch {}
    throw new ApiError(res.status, message);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}
```

UI 组件使用 Tailwind 类与 `cn`；按钮 variants：primary/secondary/ghost/danger；输入框有 focus ring；Dialog 使用原生 `<dialog>` + 受控 open；Toast 用 Context 提供 `toast(message, type)`。

- [ ] **Step 4: 通过测试与构建**

Run: `npm install`
Run: `npm run test -w @knowledge-rag/web -- cn`
Run: `npm run build -w @knowledge-rag/web`
Expected: PASS + 构建成功。

- [ ] **Step 5: 浏览器验证占位页**

启动 `npm run dev:web`，打开 `http://localhost:5173`，确认页面加载、无控制台错误、Tailwind 样式生效。

---

### Task 12: 认证页面、AuthContext 与应用外壳

**Files:**
- Create: `apps/web/src/features/auth/{LoginPage,RegisterPage,JoinPage}.tsx`
- Create: `apps/web/src/features/auth/AuthProvider.tsx`、`auth.types.ts`
- Create: `apps/web/src/app/ProtectedRoute.tsx`、`AppShell.tsx`
- Create: `apps/web/src/features/organizations/{OrgSwitcher,OrgMembersPagePlaceholder,OrgSettingsPagePlaceholder}.tsx`（具体页面在 Task 15 实现）
- Create: `apps/web/src/features/knowledge-bases/{KnowledgeBaseList,CreateKbDialog}.tsx`
- Create: `apps/web/src/app/router.tsx` 及根路由
- Create: `apps/web/src/app/NotFoundPage.tsx`、`ForbiddenPage.tsx`

**Interfaces:**
- Consumes: `/api/auth/*`、`/api/orgs/*`、`/api/knowledge-bases`
- Produces: 受保护路由；`useAuth()` 返回 `{user, organizations, activeOrgId, setActiveOrg, login, logout, register}`
- Produces: 侧栏（Logo、组织切换、KB 列表、用户菜单）、移动端抽屉
- Produces: 登录后跳转 `/orgs/:orgId`；无组织时引导创建/加入

- [ ] **Step 1: 实现页面与状态**

- `GET /api/auth/me` 作为 root query；401 跳转 `/login?next=...`。
- 登录/注册成功后 `queryClient.invalidateQueries({queryKey:['me']})`，跳转 `next || /orgs/:id`。
- 注册支持 `?invite=`，邀请 token 从 URL 传给注册接口；`/join/:token` 未登录跳注册，已登录调用 accept。
- 组织切换写入 URL（`/orgs/:orgId`），不使用 localStorage。
- 用户菜单：退出、组织成员、组织设置。
- 路由权限：无组织成员关系时显示 403；KB 列表由后端过滤。
- UI 文案中文，错误内联展示。

- [ ] **Step 2: 构建与类型检查**

Run: `npm run typecheck -w @knowledge-rag/web && npm run build -w @knowledge-rag/web`
Expected: 0。

- [ ] **Step 3: 浏览器验证**

启动 API + Web，用本地测试账号完成：注册 → 创建组织 → 登录 → 切换组织 → 退出；检查 Cookie 生效、刷新保持登录、未登录访问受保护路由跳转登录。

---

### Task 13: 知识库、文档页与实时状态

**Files:**
- Create: `apps/web/src/features/documents/{DocumentsPage,DocumentTable,UploadDropzone,StatusBadge}.tsx`
- Create: `apps/web/src/lib/socket.tsx`（SocketProvider）
- Create: `apps/web/src/features/knowledge-bases/{KbLayout,KbChatPagePlaceholder,KbMembersPagePlaceholder}.tsx`（成员页在 Task 15 实现）
- Modify: router、AppShell、KB list
- Create: `apps/web/src/features/documents/upload.ts`

**Interfaces:**
- Produces: `/orgs/:orgId/kbs/:kbId/documents` 页面
- Produces: SocketProvider 连接、`kb:join`/`kb:leave`、`document:status` 监听
- Produces: 上传（multipart `file`）、轮询降级（Socket 断开时 5s）、失败重试、下载、删除
- Produces: 知识库内导航：对话 / 文档 / 成员

- [ ] **Step 1: 实现文档页与 Socket**

- 进入 KB 时 `socket.emit('kb:join',{orgId,kbId})`，离开时 leave；ack 失败则跳 403。
- `document:status` 触发 `queryClient.invalidateQueries(['documents',orgId,kbId])`；如果 status 为 ready/failed，Toast 提示。
- 上传多文件时逐个 `POST` FormData；禁用重复提交；显示上传中与错误。
- 状态徽标：queued 灰、processing 蓝 + spinner、ready 绿、failed 红；failed 显示错误和重试按钮。
- 下载使用 `<a href={`/api/orgs/${orgId}/documents/${doc.id}/download`}>`（Cookie 自动携带）。
- 删除确认；KB 删除入口在设置菜单。
- 移动端：上传按钮与列表卡片布局。

- [ ] **Step 2: 构建与类型检查**

Run: `npm run typecheck -w @knowledge-rag/web && npm run build -w @knowledge-rag/web`
Expected: 0。

- [ ] **Step 3: 浏览器验收**

上传 txt/md/pdf/docx，观察 WebSocket 状态实时变化；断网 10 秒再恢复，确认轮询/重连；下载原文件；另一个无权账号访问返回 403/404；删除文档。

---

### Task 14: 聊天界面与来源展示

**Files:**
- Create: `apps/web/src/features/chat/{ChatPage,ConversationList,MessageList,MessageItem,Composer,SourcesPanel}.tsx`
- Create: `apps/web/src/features/chat/useChatSocket.ts`
- Create: `apps/web/src/features/chat/chatReducer.ts` + `chatReducer.spec.ts`
- Create: `apps/web/src/lib/markdown.tsx`
- Modify: router、KbLayout、SocketProvider

**Interfaces:**
- Produces: 会话列表、新建/删除会话、消息历史加载
- Produces: `chat:send` 事件与流式累积；`chat:cancel`；断线重连后刷新消息
- Produces: Markdown 渲染（禁用 raw HTML）、来源卡片展开、自动滚动
- Produces: 停止生成、Enter/Shift+Enter、问题长度限制

- [ ] **Step 1: 写失败的 reducer 测试**

```ts
it('accumulates deltas and marks done', () => {
  let s = chatReducer(initialChatState, { type: 'start', requestId: 'r1', userText: 'q' });
  s = chatReducer(s, { type: 'meta', requestId: 'r1', sources: [{ index: 1 } as never] });
  s = chatReducer(s, { type: 'delta', requestId: 'r1', text: '你' });
  s = chatReducer(s, { type: 'delta', requestId: 'r1', text: '好' });
  s = chatReducer(s, { type: 'done', requestId: 'r1', assistantMessageId: 'a1' });
  expect(s.messages.at(-1)?.content).toBe('你好');
  expect(s.streaming).toBe(false);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run test -w @knowledge-rag/web -- chatReducer`
Expected: FAIL。

- [ ] **Step 3: 实现聊天 UI**

- 进入 KB 默认路由为聊天页；加载会话列表与最近会话；新建对话发送首问时创建。
- 发送时乐观插入用户消息；`socket.emit('chat:send',{orgId,kbId,conversationId,question,requestId:crypto.randomUUID()})`。
- 监听 meta/delta/done/error，按 requestId 更新；完成后刷新会话列表。
- 停止按钮发 `chat:cancel`；被取消的回答保留并标记。
- 来源卡片展示编号、文件名、分数、片段；点击展开/收起。
- Markdown 使用 react-markdown + remark-gfm，不启用 rehype-raw；代码块可横向滚动。
- 自动滚动仅当距离底部 < 120px；显示“回到底部”按钮。
- 移动端会话列表抽屉。

- [ ] **Step 4: 通过测试与构建**

Run: `npm run test -w @knowledge-rag/web -- chatReducer`
Run: `npm run typecheck -w @knowledge-rag/web && npm run build -w @knowledge-rag/web`
Expected: PASS。

- [ ] **Step 5: 浏览器验收**

上传资料后进行多轮问答，验证流式、来源、停止、刷新后历史、中文/代码 Markdown、断网重连；检查无 console 错误。

---

### Task 15: 组织成员、邀请与知识库授权页面

**Files:**
- Create: `apps/web/src/features/organizations/{MembersTable,InviteDialog,InviteList}.tsx`
- Create: `apps/web/src/features/knowledge-bases/{KbMembersPage,KbAccessDialog,KbSettingsDialog}.tsx`
- Modify: router、AppShell、KbLayout
- Create: `apps/web/src/features/knowledge-bases/permissions.ts` + `permissions.spec.ts`

**Interfaces:**
- Produces: 组织成员角色展示/变更/移除；邀请生成/复制/撤销
- Produces: KB 成员授权（viewer/editor/manager）、访问模式切换、继承管理员提示
- Produces: `canManageKb(permission)`、`canEditDocs(permission)` 等前端辅助（仅用于隐藏入口，不替代后端）
- Consumes: 组织/KB 成员接口、AccessEvents/WebSocket 撤销事件

- [ ] **Step 1: 写失败的权限辅助测试**

```ts
it('maps kb permissions to UI capabilities', () => {
  expect(canEditDocs('viewer')).toBe(false);
  expect(canEditDocs('editor')).toBe(true);
  expect(canManageKbMembers('manager')).toBe(true);
  expect(canManageKbMembers('editor')).toBe(false);
});
```

- [ ] **Step 2: 实现页面**

- 组织成员页：成员表（姓名/邮箱/角色）、Owner 才可改角色；邀请弹窗选择 member/admin（Admin 只能 member），显示邀请链接与复制；邀请列表可撤销。
- KB 成员页：访问模式切换（团队公开/指定成员）二次确认；显式成员表；添加成员从组织成员中搜索/选择；权限下拉；移除；展示继承的 Owner/Admin/创建者。
- 所有破坏性操作确认；失败 Toast；成功后刷新查询。
- 收到 `kb:access-revoked` 后提示并返回组织首页。

- [ ] **Step 3: 构建、类型检查与浏览器验收**

Run: `npm run test -w @knowledge-rag/web -- permissions`
Run: `npm run typecheck -w @knowledge-rag/web && npm run build -w @knowledge-rag/web`
浏览器用三个账号验收：owner/admin/member；受限库不可见；viewer 无法上传；editor 可上传；manager 可授权；撤销后实时被踢出。

---

## Phase 3 — 部署

### Task 16: Docker、Compose 与 Nginx

**Files:**
- Create: `apps/api/Dockerfile`
- Create: `apps/web/Dockerfile`、`apps/web/nginx.conf`
- Create: `deploy/docker-compose.yml`、`deploy/.env.production.example`、`deploy/DEPLOY.md`
- Modify: `.gitignore`（确认 `.env.production` 忽略）
- Create: `docs/deployment-checklist.md`

**Interfaces:**
- Produces: `migrate`（一次性）、`api`（内部 3300）、`worker`、`web`（`${APP_PORT:-8088}:80`）
- Produces: `extra_hosts: host.docker.internal:host-gateway` 与 `DB_HOST=host.docker.internal`
- Produces: 上传卷 `knowledge-rag_uploads_data`；API/Worker 共享；MIGRATIONS_DIR=/app/migrations
- Produces: Nginx SPA 回退、`/api` 反代、`/socket.io` upgrade、`client_max_body_size 25m`、`proxy_buffering off`

- [ ] **Step 1: 编写镜像与 Compose**

API Dockerfile（多阶段，串行构建，限制堆）：

```dockerfile
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NODE_OPTIONS=--max-old-space-size=512
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci
COPY tsconfig.base.json ./
COPY apps/api apps/api
RUN npm run build -w @knowledge-rag/api
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production MIGRATIONS_DIR=/app/migrations
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./dist
COPY --from=build /app/apps/api/migrations ./migrations
COPY --from=build /app/apps/api/package.json ./package.json
RUN mkdir -p /data/uploads && chown -R node:node /data /app
USER node
CMD ["node", "dist/main.js"]
```

Web Dockerfile：builder 用 node 24 构建 `apps/web`，runtime 复制 `dist` 与 `nginx.conf` 到 `nginx:stable-alpine`。

Compose 关键片段：

```yaml
services:
  migrate:
    image: knowledge-rag-api:local
    env_file: .env.production
    extra_hosts: ["host.docker.internal:host-gateway"]
    command: ["node", "dist/database/migrate.js"]
    restart: "no"
  api:
    image: knowledge-rag-api:local
    build: { context: .., dockerfile: apps/api/Dockerfile }
    env_file: .env.production
    extra_hosts: ["host.docker.internal:host-gateway"]
    environment:
      NODE_OPTIONS: --max-old-space-size=256
    volumes: ["uploads_data:/data/uploads"]
    depends_on:
      migrate: { condition: service_completed_successfully }
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3300/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 5
  worker:
    image: knowledge-rag-api:local
    env_file: .env.production
    extra_hosts: ["host.docker.internal:host-gateway"]
    environment:
      NODE_OPTIONS: --max-old-space-size=384
    command: ["node", "dist/worker.js"]
    volumes: ["uploads_data:/data/uploads"]
    depends_on:
      migrate: { condition: service_completed_successfully }
    restart: unless-stopped
  web:
    image: knowledge-rag-web:local
    build: { context: .., dockerfile: apps/web/Dockerfile }
    ports: ["${APP_PORT:-8088}:80"]
    depends_on: [api]
    restart: unless-stopped
volumes:
  uploads_data:
```

> `migrate` 和 `worker` 复用 `api` 构建的镜像；不要为它们重复声明 `build`，否则 Compose 会重复构建并加剧内存压力。

Nginx 关键片段：

```nginx
client_max_body_size 25m;
location /api/ {
  proxy_pass http://api:3300;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_read_timeout 300s;
  proxy_buffering off;
  add_header X-Accel-Buffering no;
}
location /socket.io/ {
  proxy_pass http://api:3300;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
  proxy_read_timeout 600s;
}
location / { try_files $uri /index.html; }
```

`deploy/.env.production.example` 不包含真实密钥，列出全部变量与生产示例值；`DEPLOY.md` 写入服务器审计基线、构建顺序、8088 安全组、备份/回滚与 pgvector 重启策略操作。

- [ ] **Step 2: 本地无法构建 Docker（本机无 Docker），在服务器验证前先做静态检查**

Run: `npm run build`（本地确保前后端产物可构建）
Run: `npx tsc --noEmit -p apps/web/tsconfig.json`
Expected: 0。

- [ ] **Step 3: 上传到服务器并做 compose 配置检查（不启动）**

通过 SSH 上传项目（排除 node_modules/.env/storage），在 `/opt/knowledge-rag` 执行：

```bash
cd /opt/knowledge-rag/deploy
APP_PORT=8088 docker compose --env-file .env.production -p knowledge-rag config >/dev/null
```
Expected: 配置校验通过，不创建容器。

- [ ] **Step 4: 串行构建镜像**

```bash
cd /opt/knowledge-rag/deploy
docker compose --env-file .env.production -p knowledge-rag build api
docker compose --env-file .env.production -p knowledge-rag build web
```
Expected: 构建成功；内存不足时先停下汇报，不重启现有容器，不使用 `docker system prune`。

---

### Task 17: 实际部署到 ECS 并验收

**Files:**
- Create on server: `/opt/knowledge-rag/deploy/.env.production`（不提交）
- Modify server: `pgvector` restart policy（已获授权）
- Create: `docs/deployment-record.md`（部署结果、端口、版本、验证记录）

**Interfaces:**
- Produces: `http://<SERVER_IP>:8088` 可访问
- Produces: `knowledge_rag` 库与 `pgboss` schema
- Produces: 现有 80/8000/3306/5432 服务保持运行

- [ ] **Step 1: 生成生产 env（本地）**

从现有 `.env` 复制密钥，生成 `deploy/.env.production`，至少包含：

```dotenv
PORT=3300
APP_PORT=8088
APP_ORIGIN=http://<SERVER_IP>:8088
COOKIE_SECURE=false
REGISTRATION_ENABLED=true
API_KEY=<沿用>
BASE_URL=https://api.siliconflow.cn/v1
MODEL=deepseek-ai/DeepSeek-V4.1-Flash
EMBEDDING_MODEL=BAAI/bge-m3
EMBEDDING_DIMENSIONS=1024
DB_HOST=host.docker.internal
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=<沿用>
DB_NAME=knowledge_rag
DB_SSL=false
UPLOAD_DIR=/data/uploads
MAX_UPLOAD_MB=20
CHUNK_SIZE=800
CHUNK_OVERLAP=120
RETRIEVAL_TOP_K=6
RETRIEVAL_MIN_SCORE=0.2
SESSION_TTL_DAYS=7
WORKER_CONCURRENCY=1
```

用 `scp` 传到服务器；不要输出文件内容。

- [ ] **Step 2: 部署前快照**

在服务器记录但不改动：

```bash
docker ps --format '{{.Names}} {{.Ports}}'
ss -tlnp | grep -E ':(80|8000|8088|3306|5432)\b'
```
确认 8088 空闲、现有容器状态与审计一致。

- [ ] **Step 3: 启动并迁移**

```bash
cd /opt/knowledge-rag/deploy
docker compose --env-file .env.production -p knowledge-rag up -d
docker compose --env-file .env.production -p knowledge-rag ps
docker compose --env-file .env.production -p knowledge-rag logs --tail=100 migrate
docker compose --env-file .env.production -p knowledge-rag logs --tail=100 api
```
Expected: migrate 退出码 0；api/worker/web Up；健康检查通过。

- [ ] **Step 4: 调整 pgvector 重启策略（已授权）**

```bash
docker update --restart unless-stopped pgvector
docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' pgvector
```
Expected: `unless-stopped`，现有容器不重启。

- [ ] **Step 5: 公网验证**

在本地执行：

```bash
curl -fsS http://<SERVER_IP>:8088/api/health
```
Expected: `{"status":"ok","db":"ok","queue":"ok"}`。
若失败，检查阿里云安全组 8088、firewalld、容器日志；不改现有服务端口。

- [ ] **Step 6: 浏览器端到端验收**

访问 `http://<SERVER_IP>:8088`：

1. 注册账号（记录测试账号，部署记录中注明）。
2. 创建知识库，上传 TXT/PDF/DOCX，确认 WebSocket 状态实时变为 ready。
3. 提问并确认流式回答、来源、停止生成。
4. 创建邀请，第二个账号加入；验证角色和 KB 授权。
5. 验证受限 KB、下载鉴权、跨组织 404。
6. 确认 80 端口现有 xflow 页面仍可访问、travel 8000 正常。

- [ ] **Step 7: 记录部署结果**

`docs/deployment-record.md`：镜像版本/构建时间、容器状态、公网地址、健康检查、验收结果、测试账号（不含密码）、回滚命令、已知风险。

---

## Phase 4 — 收尾

### Task 18: 全量验证与文档

**Files:**
- Modify: `README.md`
- Create: `docs/operations.md`（备份、日志、升级、回滚、常见问题）
- Modify: `docs/deployment-record.md`

- [ ] **Step 1: 本地全量验证**

Run: `npm run typecheck`
Run: `npm test`
Run: `npm run test:e2e -w @knowledge-rag/api`
Run: `npm run build`
Expected: 全部通过。

- [ ] **Step 2: 生产验证**

Run: `curl -fsS http://<SERVER_IP>:8088/api/health`
Run: `docker compose --env-file .env.production -p knowledge-rag ps`（服务器）
Run: `curl -s -o /dev/null -w '%{http_code}' http://<SERVER_IP>/`（确认现有 80 服务）
Expected: 健康检查 200；容器 Up；现有 xflow 返回 200/301/302。

- [ ] **Step 3: 文档**

README 包含：项目简介、架构图、本地启动、环境变量、迁移、测试、Docker 部署、默认端口。`docs/operations.md` 包含：日志、容器重启、备份 `pg_dump knowledge_rag` 与上传卷、升级、回滚、8088 安全组、HTTP→HTTPS 后续步骤。

- [ ] **Step 4: 最终自检**

对照 spec §20 验收标准逐条打勾；记录未完成项（若有）并说明原因。

---

## Spec Coverage

| Spec 章节 | 实现任务 |
|---|---|
| §6 数据模型 | Task 2 |
| §7 认证与会话 | Task 3 |
| §8 多租户与权限 | Task 4、5、10、15 |
| §9 REST API | Task 3–9 |
| §10 WebSocket | Task 10、14 |
| §11 RAG | Task 7–9 |
| §12 队列与 Worker | Task 7、16 |
| §13 文件存储 | Task 6、16 |
| §14 前端 | Task 11–15 |
| §15 安全 | Task 3、6、10、16 |
| §16 环境变量 | Task 2、16、17 |
| §17 部署 | Task 16、17 |
| §18 测试 | 每个 Task 的测试步骤 |
| §20 验收标准 | Task 18 |
