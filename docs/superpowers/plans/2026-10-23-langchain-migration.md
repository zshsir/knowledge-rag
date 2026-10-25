# LangChain 迁移 + 中文注释补齐 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把后端 RAG 链路（解析、切分、嵌入、检索、生成）改用 LangChain 抽象实现，并给全仓库代码补齐中文注释，对外行为、数据库结构与生产数据零变化。

**Architecture:** LangChain 负责 `Document` 数据模型、`RecursiveCharacterTextSplitter` 切分、`OpenAIEmbeddings`/`ChatOpenAI` 模型调用、`BaseRetriever` 检索抽象与 `ChatPromptTemplate` 提示编排；向量表与检索 SQL 保留现有实现（用自定义 `KbRetriever` 包住），因此多租户隔离、`status='ready'` 过滤、HNSW 索引与生产数据全部不动。

**Tech Stack:** NestJS 11（CommonJS）、Node 22、`@langchain/core@1.3.0`、`@langchain/openai@1.7.0`、`@langchain/community@1.1.29`、`@langchain/textsplitters@1.0.2`、pg + pgvector、pg-boss 11、Socket.IO、React 19 + Vite + Vitest、Jest（e2e）。

**Spec:** `docs/superpowers/specs/2026-10-23-langchain-migration-design.md`

## Global Constraints

每个任务的隐含要求，逐条来自 spec，值必须原样遵守：

- 依赖版本：`@langchain/core ^1.3.0`、`@langchain/openai ^1.7.0`（`engines.node >= 22`）、`@langchain/community ^1.1.29`、`@langchain/textsplitters ^1.0.2`；不得引入 `@langchain/classic`
- 构建产物必须是 CommonJS 可 `require` 的形式；不得把 `apps/api` 改成 ESM
- 不变项：数据库迁移（只有已存在的 `001`/`002`）、REST 路径与响应体、WebSocket 事件名 `chat:send/meta/delta/done/error`、`apps/web` 全部代码、生产 `knowledge_rag` 库与 uploads 卷
- 必须保留的行为契约（e2e 已断言）：PDF 超过 200 页拒绝、PDF 解析 60s 超时、`PDF 未包含可提取文本，可能是扫描件`（归一化后长度 < 20）、`DOCX 未包含可提取文本`、TXT/MD 的 GB18030 编码回退、嵌入维度必须等于 `config.embedding.dimensions`（1024）、检索阈值 `1 - 距离 >= retrievalMinScore`、引用编号从 1 开始、中断时半条回答落库并标记 `interrupted`
- 服务器约束：ECS 内存 1.8GB，Docker 构建必须串行，禁止 `docker system prune`；现有 80/8000/3306/5432 端口与 xflow/travel/pgvector/my-mysql 容器不得改动
- 安全约束：不得把 `API_KEY`、`DB_PASSWORD`、`.env`、`deploy/.env.production` 的内容输出到日志或提交物；本地 dev 用 `knowledge_rag_dev`，e2e 用 `knowledge_rag_test`，生产用 `knowledge_rag`
- **本仓库不是 git 仓库**（无 VCS）：所有「提交」步骤替换为「验证闸口」——跑完类型检查 + 相关测试并确认全绿才算该任务完成；禁止用 `git checkout`/`reset` 回滚，改动前如需保护文件，先复制为 `*.tmp-bak` 并在任务结束时删除
- **中文注释规范**（Phase A 与 Phase B 全部适用）：
  1. 文件头块注释：这个文件负责什么、边界在哪（不做什么）
  2. 导出的类/函数：说明「做什么」+「步骤 1./2./3.」，参数与返回值有非显然含义时补一句原因
  3. 关键语句前用单行注释定位（如 `// 步骤 2：pgvector 近邻检索`），禁止复述语法的空话注释（`// 赋值给 x`）
  4. 样板见 `apps/api/src/chat/retrieval.service.ts`，以其风格为准

---

## Phase A：中文注释补齐（零逻辑改动）

Phase A 的每个任务都是同一套动作，且**必须在 Phase B 之前完成自己负责的文件**；`llm/`、`ingestion/`、`chat/` 三个目录不在 Phase A 范围内（会被重写，注释在 Phase B 各任务内同步产出）。

Phase A 统一验证命令（后端）：

```bash
cd apps/api && npm run typecheck && npm test
```

期望：`Tests: 23 passed`（Phase A 期间测试数不变，因为不改测试逻辑）；类型检查无输出。

Phase A 统一验证命令（前端）：

```bash
cd apps/web && npm run typecheck && npx vitest run
```

期望：`Tests: 9 passed`。

### Task 1 (A1): 后端基础设施注释（config / database / 入口）

**Files:**
- Modify: `apps/api/src/config/`（4 个文件：config.module.ts、config.service.ts、load-env.ts、env.util.ts）
- Modify: `apps/api/src/database/`（14 个文件：database.module.ts、database.service.ts、migrate.ts、`repositories/` 下 11 个仓储）
- Modify: `apps/api/src/`（4 个文件：main.ts、app.module.ts、worker.ts、以及 `src/` 根下其余非 spec 的 .ts）

用 `find apps/api/src/config apps/api/src/database -name '*.ts' ! -name '*.spec.ts'` 与 `find apps/api/src -maxdepth 1 -name '*.ts' ! -name '*.spec.ts'` 得到确切清单，逐个补注释。

**Interfaces:**
- Consumes: 无
- Produces: 无对外接口变化（仅注释）

- [ ] **Step 1: 给 config 模块补注释**

每个文件加文件头块注释，说明职责边界。`config.service.ts` 的每个 getter 前补一行说明该配置影响什么行为，必须写清这几项的取值含义：

```ts
  /**
   * 大模型服务配置（SiliconFlow 等 OpenAI 兼容服务）。
   * - apiKey：Bearer 令牌，绝不输出到日志
   * - baseUrl：去掉结尾斜杠，因为代码里会拼 `${baseUrl}/embeddings`
   * - model：对话模型名，默认 deepseek-ai/DeepSeek-V4.1-Flash
   */
  get llm() {
```

`env.util.ts` 的 `hashToken` 说明「会话令牌与邀请令牌都只存 SHA-256 摘要，库被拖走也无法还原可用令牌」。`load-env.ts` 说明「迁移脚本是独立进程，拿不到 Nest 的 ConfigModule，所以自己按 `cwd/.env` → `cwd/../../.env` 顺序读文件」。

- [ ] **Step 2: 给 database 模块补注释**

`database.service.ts` 头部说明连接池与 `withTransaction`；`withTransaction` 内注释写清「BEGIN → 回调 → COMMIT，回调抛错则 ROLLBACK 并原样抛出，绝不吞异常」。

`migrate.ts` 写步骤注释：

```ts
/**
 * 独立迁移脚本（Docker 里作为一次性 migrate 容器运行）。
 * 步骤：
 * 1. 先连到 maintenance db（postgres），目标库不存在时创建——首次部署能自愈
 * 2. 拿 pg advisory lock，避免多实例同时迁移
 * 3. 读 MIGRATIONS_DIR 下 .sql 按文件名升序逐条执行；迁移必须幂等（IF NOT EXISTS）
 * 4. 记录已应用迁移，重复执行不会二次生效
 */
```

11 个仓储文件：文件头说明「只负责 SQL，不含业务规则」，每个方法一行说明它守护的隔离条件——凡是带 `org_id` 的查询都要写明「org_id 条件是多租户的硬边界，去掉就会跨组织读数据」。

- [ ] **Step 3: 给入口文件补注释**

`main.ts` 写启动顺序（前缀 `api`、cookie-parser、全局 ValidationPipe、CORS/Origin 守卫、异常过滤器、监听端口）；`worker.ts` 说明「与 API 同镜像不同进程，只装载 WorkerModule，避免 API 进程加载 pdf-parse/canvas 导致 Jest 句柄泄漏」；`app.module.ts` 说明各业务模块与全局模块的组合关系。

- [ ] **Step 4: 验证闸口**

Run: `cd apps/api && npm run typecheck && npm test`
Expected: 类型检查无错误，`Tests: 23 passed`。若测试数变化，说明误改了逻辑，必须回退该文件改动。

### Task 2 (A2): 认证与权限层注释（common / auth）

**Files:**
- Modify: `apps/api/src/common/`（15 个文件：types.ts、decorators/ 6 个、guards/ 5 个、filters/all-exceptions.filter.ts、events/ 2 个）
- Modify: `apps/api/src/auth/`（8 个文件：auth.controller.ts、auth.service.ts、session.service.ts、password.service.ts、dto/、auth.module.ts）

- [ ] **Step 1: 给 common 补注释**

守卫是重点，必须写清「拦什么、放行条件、失败返回什么」：

```ts
/**
 * 知识库权限守卫：解析当前用户对该知识库的有效权限，并校验是否达到接口要求的等级。
 * 步骤：
 * 1. 从路由参数取 orgId/kbId，交给 KbAccessService 解析有效权限（owner/admin 穿透、创建者、显式授权、组织公开）
 * 2. 把结果挂到 request.kbPermission 上，供 @CurrentKbPermission() 读取
 * 3. 权限等级低于 @RequireKbPermission() 声明的门槛时抛 ForbiddenException(403)
 * 边界：只判定权限，不做任何数据读写
 */
```

`origin.guard.ts` 说明「校验请求 Origin 是否等于 APP_ORIGIN，等价于 CSRF 防护，因为 Session 走 Cookie」；`app-throttler.guard.ts` 说明「测试环境跳过，否则 e2e 注册多个账号会被限流打挂」；`all-exceptions.filter.ts` 说明「统一错误形状，且绝不把内部堆栈返回给前端」。

装饰器目录：每个一行说明它从 request 上取什么、什么情况下会是 undefined。

- [ ] **Step 2: 给 auth 补注释**

`auth.service.ts` 的 `register` 写完整步骤注释（邮箱查重 → 建用户 → 有 inviteToken 则锁邀请行校验有效期并建成员关系（含知识库授权）→ 否则要求开放注册且建组织+owner → 建会话）。

`session.service.ts` 说明：

```ts
/**
 * 会话服务：随机 32 字节 base64url 令牌，库里只存 SHA-256 摘要。
 * 步骤：
 * 1. 签发：生成明文令牌 → 存摘要 → 返回明文给浏览器（Cookie 里那次是唯一可见明文的机会）
 * 2. 校验：摘要反查会话，顺带滑动续期；查不到就 401，不区分「不存在」和「已过期」
 * 边界：不缓存会话，改密码/被移出组织时通过删除会话行来失效
 */
```

`password.service.ts` 说明 bcrypt 轮数来自配置（测试环境降到 4 以加速 e2e）。

- [ ] **Step 3: 验证闸口**

Run: `cd apps/api && npm run typecheck && npm test && npm run test:e2e -- auth organizations`
Expected: 单测 23 passed；e2e 两个 suite 全绿。

### Task 3 (A3): 组织与知识库业务注释（organizations / knowledge-bases）

**Files:**
- Modify: `apps/api/src/organizations/`（10 个文件）
- Modify: `apps/api/src/knowledge-bases/`（9 个文件）

- [ ] **Step 1: organizations 补注释**

`members.service.ts` 必须写清角色规则表（谁能改谁的角色、谁能移除谁、owner 不可被降级），以及「移除成员时同步删掉其知识库授权和会话，并广播权限回收事件」这一步的原因：

```ts
    // 步骤 3：清理该成员在本组织下的知识库授权与会话，并通知在线连接
    // 原因：只删成员关系会留下「已无组织身份但仍有 kb 授权行」的脏状态，
    //      且已建立的 WebSocket 会话会继续持有访问能力
```

`invites.service.ts` 说明一次性令牌语义（`token_hash` 唯一、`accepted_at` 非空即作废、7 天过期）、`createForKb` 与普通 `create` 的权限差异（前者由知识库 manager 守卫授权，角色固定 member）、`accept` 事务内「锁邀请行 → 查重 → 建成员 → 若带 kb_id 则同时写知识库授权 → 标记已用」的顺序。

- [ ] **Step 2: knowledge-bases 补注释**

`kb-access.service.ts` 是权限模型的心脏，必须把判定顺序写成注释表：

```ts
/**
 * 解析用户对某知识库的「有效权限」。判定顺序（先命中即返回）：
 * 1. 组织 owner/admin → manager（管理员穿透，避免把自己锁在门外）
 * 2. 知识库创建者 → manager
 * 3. 显式授权行（knowledge_base_members）→ 其记录的权限
 * 4. 知识库为组织公开（access_mode='org'）→ viewer
 * 5. 以上都不满足 → null（接口按 403/404 处理）
 */
```

`knowledge-bases.service.ts` 说明「切到 restricted 时向被回收权限的用户广播事件，让在线会话立刻失效」；`kb-members.service.ts` 的 `add` 写清三条分支（组织内 userId 直接授权 / 邮箱命中已注册但不在组织 → 先拉入组织为 member 再授权 / 邮箱未注册 → 生成知识库作用域邀请链接）。

- [ ] **Step 3: 验证闸口**

Run: `cd apps/api && npm run typecheck && npm run test:e2e -- knowledge-bases organizations`
Expected: 两个 suite 全绿（knowledge-bases 应为 5 个用例）。

### Task 4 (A4): 文档、存储、队列、实时注释（documents / storage / queue / realtime）

**Files:**
- Modify: `apps/api/src/documents/`（4 个文件）
- Modify: `apps/api/src/storage/`（2 个文件）
- Modify: `apps/api/src/queue/`（3 个文件）
- Modify: `apps/api/src/realtime/`（4 个文件）

- [ ] **Step 1: documents 补注释**

`document-validation.ts` 必须把乱码修复函数讲清楚（这是修过的线上事故）：

```ts
/**
 * 修复 multipart 上传中文文件名乱码。
 * 背景：部分客户端按 latin1 声明文件名，中文会被逐字节解成 U+0080-U+00FF 的乱码字符。
 * 步骤：
 * 1. 只要出现码点 > 0xFF 的字符，说明已经是正确的 Unicode，原样返回（避免二次误解码）
 * 2. 否则按 latin1 → utf8 重新解码
 * 3. 解码结果含 U+FFFD（替换字符）说明猜错了，返回原值，绝不返回更坏的结果
 */
```

`documents.service.ts` 说明上传落盘 → 建 documents 行（status=queued）→ 投递 pg-boss 任务的顺序，以及 `listChunks` 的 viewer 权限前置。

- [ ] **Step 2: storage / queue 补注释**

`storage.service.ts` 的 `absolutePath` 必须写明路径穿越防护（resolve 后必须仍在 root 前缀内，否则 400）——这是安全边界，不能只当工具函数。

`queue.service.ts` 说明 pg-boss 选型原因（复用 Postgres，不引入 Redis）、任务参数（retryLimit 2、指数退避、expireInSeconds 1800、singletonKey 去重）、`work` 按 `workerConcurrency` 注册多个 worker、优雅停机 `boss.stop()`。

- [ ] **Step 3: realtime 补注释**

`realtime.gateway.ts` 说明握手期中间件（复用会话校验 + Origin 校验，WebSocket 不受 HTTP 中间件保护）、房间命名 `kb:{kbId}` / `user:{id}`、chat 事件协议与取消语义。`realtime.listener.ts` 说明 `LISTEN kr_document_status` 断线重连与 `ready` 承诺（避免 worker 先于监听器就绪导致状态不刷新）。

- [ ] **Step 4: 验证闸口**

Run: `cd apps/api && npm run typecheck && npm run test:e2e -- documents realtime ingestion`
Expected: 三个 suite 全绿。

### Task 5 (A5): 前端基础设施注释（components / lib）

**Files:**
- Modify: `apps/web/src/components/`（13 个文件）
- Modify: `apps/web/src/lib/`（6 个文件：api.ts、socket.tsx、types.ts、format.ts、clipboard.ts、cn.ts）
- Modify: `apps/web/src/`（根下 1 个非 spec 文件，如 main.tsx/App.tsx）

- [ ] **Step 1: lib 补注释**

`api.ts` 写请求约定：

```ts
/**
 * 前端统一 API 客户端。
 * 约定：
 * 1. 一律带 credentials:'include'，Session 靠 httpOnly Cookie，前端拿不到令牌
 * 2. 非 2xx 统一抛 ApiError（带 status 与后端 message），调用方只在 UI 层决定怎么展示
 * 3. 401 时派发全局 auth:unauthorized 事件，由 AuthProvider 统一跳登录，避免每个页面各写一遍
 * 4. FormData 请求不能手设 Content-Type，否则浏览器不生成 boundary（上传乱码的诱因之一）
 */
```

`socket.tsx` 说明房间加入时机与 `kb:join` ack；`types.ts` 每个接口一行说明它对应哪个后端响应，并标注与后端字段的一致性来源（`OrgMember`/`KbMember`/`CreatedInvite` 等）。

- [ ] **Step 2: components/ui 补注释**

每个组件文件头说明用途与关键可访问性/布局决策。`dialog.tsx` 必须记录踩过的坑：

```ts
/**
 * 模态对话框（原生 <dialog>）。
 * 注意：必须显式 m-auto，否则原生 dialog 会贴在视口左上角；
 *      max-h-[calc(100dvh-2rem)] + overflow-hidden 防止内容超高时溢出屏幕。
 */
```

`confirm-dialog.tsx`、`toast`、`empty-state`、`avatar`、`badge`、`spinner` 同理，各写职责与一处非显然细节。

- [ ] **Step 3: 验证闸口**

Run: `cd apps/web && npm run typecheck && npx vitest run`
Expected: `Tests: 9 passed`。

### Task 6 (A6): 前端功能页注释（features/*）

**Files:**
- Modify: `apps/web/src/features/auth/`（6 个文件，含 AuthLayout.tsx、KnowledgeMap.tsx、JoinPage.tsx、RegisterPage.tsx、LoginPage.tsx、AuthProvider.tsx）
- Modify: `apps/web/src/features/chat/`（5 个文件）
- Modify: `apps/web/src/features/documents/`（3 个文件）
- Modify: `apps/web/src/features/knowledge-bases/`（7 个文件）
- Modify: `apps/web/src/features/organizations/`（4 个文件）
- Modify: `apps/web/src/features/` 其余目录（用 `find apps/web/src/features -name '*.tsx' ! -name '*.spec.tsx'` 取全量清单）

- [ ] **Step 1: chat 功能补注释（含两处修过的行为）**

`ChatPage.tsx` 必须把「回答完成后不闪空白」的修复写成注释，否则后人会改回去：

```ts
      // 步骤 3：先把消息写进查询缓存，再切换当前会话
      // 原因：若先切 activeId 再拉取，MessagesList 会有一帧无数据 → 页面闪空白（已修过的线上问题）
      await queryClient.fetchQuery({ queryKey: ['messages', orgId, event.conversationId], ... });
      setActiveId(event.conversationId);
```

`chatReducer.ts`（或同名逻辑）说明 delta 合并、meta 先到、done 收尾、cancel 保留半条的状态机。

- [ ] **Step 2: documents / knowledge-bases / organizations / auth 功能补注释**

`DocumentsPage.tsx` 说明固定列宽模板（表头与行必须共用同一套 `lg:grid-cols-[...]`，否则 `auto` 列宽不一致会错位）与点击展开片段的取数策略。`CreateKbDialog.tsx` 说明 `useId()` 生成唯一表单 ID 的原因（同页多个 dialog 实例会导致 `invalid form control with name='' is not focusable`）。`KbMembersPage.tsx` 说明「组织成员 / 按邮箱添加」两条分支与邀请链接返回态。`AuthLayout.tsx`/`KnowledgeMap.tsx` 说明视觉结构与响应式断点取舍。

- [ ] **Step 3: 验证闸口**

Run: `cd apps/web && npm run typecheck && npx vitest run && npm run build`
Expected: 测试 9 passed，构建成功。

---

## Phase B：LangChain 迁移（TDD，新代码自带中文注释）

Phase B 顺序不可打乱：模型层 → 解析切分 → 入库 → 检索 → 生成 → 清理。每个任务结束时后端全量测试必须绿（单测数量会因新增而增加，因删除而减少，但**不允许出现失败**）。

Phase B 统一验证命令：

```bash
cd apps/api && npm run typecheck && npm test && npm run test:e2e
```

期望：9 个 e2e suite 全绿；单测数量与新增/删除的 spec 一致。

### Task 7 (B1): 安装 LangChain 依赖并实现嵌入服务

**Files:**
- Modify: `apps/api/package.json`（dependencies）
- Create: `apps/api/src/llm/llm.tokens.ts`
- Create: `apps/api/src/llm/embeddings.service.ts`
- Create: `apps/api/src/llm/embeddings.service.spec.ts`
- Modify: `apps/api/src/llm/llm.module.ts`

**Interfaces:**
- Consumes: `AppConfigService.llm.{apiKey,baseUrl}`、`AppConfigService.embedding.{model,dimensions}`
- Produces:
  - `const EMBEDDINGS_PROVIDER: string`（NestJS 注入 token，值 `'EMBEDDINGS_PROVIDER'`）
  - `interface EmbeddingsProvider { embedDocuments(texts: string[], options?: { signal?: AbortSignal }): Promise<number[][]>; }`
  - `class EmbeddingsService { embed(inputs: string[], signal?: AbortSignal): Promise<number[][]>; }`

- [ ] **Step 1: 安装依赖**

Run:
```bash
cd apps/api && npm i @langchain/core@^1.3.0 @langchain/openai@^1.7.0 @langchain/community@^1.1.29 @langchain/textsplitters@^1.0.2
```
Expected: `package.json` 出现四个依赖，`package-lock.json` 已更新（Docker 构建用 `npm ci`，锁文件必须同步到服务器）。

- [ ] **Step 2: 写失败的嵌入服务测试**

Create `apps/api/src/llm/embeddings.service.spec.ts`：

```ts
import { EmbeddingsService } from './embeddings.service';
import { LlmError } from './llm.errors';

function fakeConfig(dimensions = 1024) {
  return { embedding: { model: 'BAAI/bge-m3', dimensions }, llm: { apiKey: 'k', baseUrl: 'https://x/v1', model: 'm' } } as never;
}

function vector(value: number, dimensions = 1024) {
  return Array.from({ length: dimensions }, () => value);
}

describe('EmbeddingsService', () => {
  it('按 16 条一批调用 provider 并保持顺序', async () => {
    const calls: string[][] = [];
    const provider = {
      embedDocuments: async (texts: string[]) => {
        calls.push(texts);
        return texts.map((_, i) => vector(i));
      },
    };
    const service = new EmbeddingsService(provider as never, fakeConfig());
    const inputs = Array.from({ length: 20 }, (_, i) => `t${i}`);

    const result = await service.embed(inputs);

    expect(calls.map((call) => call.length)).toEqual([16, 4]);
    expect(result).toHaveLength(20);
  });

  it('provider 返回数量不匹配时抛 LlmError', async () => {
    const provider = { embedDocuments: async () => [vector(1)] };
    const service = new EmbeddingsService(provider as never, fakeConfig());
    await expect(service.embed(['a', 'b'])).rejects.toThrow(LlmError);
  });

  it('维度不符合配置时抛 LlmError（防止脏向量写库）', async () => {
    const provider = { embedDocuments: async (texts: string[]) => texts.map(() => vector(1, 512)) };
    const service = new EmbeddingsService(provider as never, fakeConfig(1024));
    await expect(service.embed(['a'])).rejects.toThrow(/维度不正确/);
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `cd apps/api && npx jest src/llm/embeddings.service.spec.ts`
Expected: FAIL，提示找不到 `./embeddings.service`。

- [ ] **Step 4: 实现 token 与嵌入服务（带中文注释）**

Create `apps/api/src/llm/llm.tokens.ts`：

```ts
/**
 * 模型层的注入 token 与最小依赖接口。
 * 边界：这里只声明「我们需要什么能力」，不关心具体是哪家模型服务，
 *      便于测试用假实现覆盖 provider，e2e 不打真实 API。
 */

/** 向量嵌入 provider 的注入 token（测试里用 overrideProvider 换成假实现） */
export const EMBEDDINGS_PROVIDER = 'EMBEDDINGS_PROVIDER';

/** 对话模型 provider 的注入 token */
export const CHAT_MODEL_PROVIDER = 'CHAT_MODEL_PROVIDER';

/** LangChain Embeddings 的最小子集，OpenAIEmbeddings 天然满足 */
export interface EmbeddingsProvider {
  embedDocuments(
    texts: string[],
    options?: { signal?: AbortSignal },
  ): Promise<number[][]>;
}
```

Create `apps/api/src/llm/embeddings.service.ts`：

```ts
/**
 * 嵌入服务：把文本批量转成向量。
 * 职责：分批调用 provider + 校验返回数量与维度；不做检索、不写库。
 */
import { Inject, Injectable } from '@nestjs/common';
import { AppConfigService } from '../config/config.service';
import { LlmError } from './llm.errors';
import { EMBEDDINGS_PROVIDER, EmbeddingsProvider } from './llm.tokens';

/** 单次请求最大条数，与模型服务端限制对齐 */
const EMBED_BATCH_SIZE = 16;

@Injectable()
export class EmbeddingsService {
  constructor(
    @Inject(EMBEDDINGS_PROVIDER) private readonly provider: EmbeddingsProvider,
    private readonly config: AppConfigService,
  ) {}

  /**
   * 批量嵌入。
   * 步骤：
   * 1. 按 16 条一批切分输入，逐批调用 provider（一次塞太多会被上游拒或超时）
   * 2. 校验每批返回条数必须等于请求条数，否则顺序会错位（片段与向量对不上是静默错误，必须炸）
   * 3. 校验维度等于配置（默认 1024），维度不符写库时才会报错，那时文档已经失败一半
   */
  async embed(inputs: string[], signal?: AbortSignal): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let i = 0; i < inputs.length; i += EMBED_BATCH_SIZE) {
      const batch = inputs.slice(i, i + EMBED_BATCH_SIZE);
      const result = await this.provider.embedDocuments(batch, { signal });
      if (result.length !== batch.length) {
        throw new LlmError('Embedding 返回数量不正确');
      }
      for (const vector of result) {
        if (vector.length !== this.config.embedding.dimensions) {
          throw new LlmError(
            `Embedding 维度不正确，期望 ${this.config.embedding.dimensions}`,
          );
        }
        vectors.push(vector);
      }
    }
    return vectors;
  }
}
```

- [ ] **Step 5: 注册 provider 工厂**

Modify `apps/api/src/llm/llm.module.ts`（此步只加嵌入，对话 provider 在 B2 加）：

```ts
/**
 * 模型层模块。全局模块：入库 worker、对话、检索都依赖它。
 * 注意 provider 用工厂单独注册，测试可以只换 provider 而不动服务逻辑。
 */
import { Global, Module } from '@nestjs/common';
import { OpenAIEmbeddings } from '@langchain/openai';
import { AppConfigService } from '../config/config.service';
import { EMBEDDINGS_PROVIDER } from './llm.tokens';
import { EmbeddingsService } from './embeddings.service';

@Global()
@Module({
  providers: [
    EmbeddingsService,
    {
      provide: EMBEDDINGS_PROVIDER,
      // SiliconFlow 兼容 OpenAI 协议，因此直接复用 OpenAIEmbeddings 换 baseURL
      useFactory: (config: AppConfigService) =>
        new OpenAIEmbeddings({
          model: config.embedding.model,
          apiKey: config.llm.apiKey,
          configuration: { baseURL: config.llm.baseUrl },
          maxRetries: 3,
          timeout: 60_000,
        }),
      inject: [AppConfigService],
    },
  ],
  exports: [EmbeddingsService, EMBEDDINGS_PROVIDER, CHAT_MODEL_PROVIDER],
})
export class LlmModule {}
```

同时 `import { CHAT_MODEL_PROVIDER }`（B2 前先在 providers 里留注释占位说明，或直接把 exports 写全、providers 到 B2 补齐——B1 阶段只 export 已存在的 provider，避免运行期找不到依赖）。B1 的 `exports` 应为 `[EmbeddingsService, EMBEDDINGS_PROVIDER]`。

- [ ] **Step 6: 运行测试确认通过**

Run: `cd apps/api && npm run typecheck && npx jest src/llm`
Expected: 3 个用例 PASS。

- [ ] **Step 7: 验证闸口**

Run: `cd apps/api && npm test`
Expected: 全绿（`LlmService` 仍在，旧测试不受影响）。

### Task 8 (B2): 实现 LangChain 对话模型服务

**Files:**
- Create: `apps/api/src/llm/chat-model.service.ts`
- Create: `apps/api/src/llm/chat-model.service.spec.ts`
- Modify: `apps/api/src/llm/llm.tokens.ts`
- Modify: `apps/api/src/llm/llm.module.ts`

**Interfaces:**
- Consumes: `EMBEDDINGS_PROVIDER` 同款工厂模式；`ChatMessage`（`apps/api/src/llm/llm.types.ts`）
- Produces: `class ChatModelService { stream(messages: ChatMessage[], signal?: AbortSignal): AsyncGenerator<string>; }`

- [ ] **Step 1: 写失败的流式测试**

Create `apps/api/src/llm/chat-model.service.spec.ts`：

```ts
import { ChatModelService } from './chat-model.service';

/** 造一个只实现 streamEvents 的假模型，避免真实网络请求 */
function fakeModel(tokens: string[]) {
  return {
    streamEvents: async (_input: unknown, _options: unknown) => {
      return {
        async *[Symbol.asyncIterator]() {
          for (const token of tokens) yield token;
        },
      };
    },
  };
}

async function collect(generator: AsyncGenerator<string>) {
  const out: string[] = [];
  for await (const chunk of generator) out.push(chunk);
  return out;
}

describe('ChatModelService', () => {
  it('按顺序透传模型产出的增量 token', async () => {
    const service = new ChatModelService(fakeModel(['你', '好']) as never);
    const result = await collect(
      service.stream([{ role: 'user', content: 'hi' }]),
    );
    expect(result).toEqual(['你', '好']);
  });

  it('跳过空增量，避免前端收到无意义 delta', async () => {
    const service = new ChatModelService(fakeModel(['a', '', 'b']) as never);
    const result = await collect(
      service.stream([{ role: 'user', content: 'hi' }]),
    );
    expect(result).toEqual(['a', 'b']);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/api && npx jest src/llm/chat-model`
Expected: FAIL，找不到 `./chat-model.service`。

- [ ] **Step 3: 实现对话服务**

Create `apps/api/src/llm/chat-model.service.ts`：

```ts
/**
 * 对话模型服务：只负责「把消息喂给模型，把 token 流吐出来」。
 * 边界：不拼提示词（在 chat/rag-prompt.ts）、不落库（在 chat/chat.service.ts）、
 *      不决定中断后怎么保存（由调用方累加增量，天然支持「停止生成保留半条」）。
 */
import { Inject, Injectable } from '@nestjs/common';
import { ChatMessage } from './llm.types';
import { CHAT_MODEL_PROVIDER, ChatModelProvider } from './llm.tokens';

/** 单次回答总超时：模型超时是单请求级，长回答需要外层兜底 */
const CHAT_TIMEOUT_MS = 5 * 60_000;

@Injectable()
export class ChatModelService {
  constructor(
    @Inject(CHAT_MODEL_PROVIDER) private readonly model: ChatModelProvider,
  ) {}

  /**
   * 流式生成。
   * 步骤：
   * 1. 用 streamEvents 拿到纯文本增量流（LangChain 已替我们解析 SSE）
   * 2. 传入 signal：用户点「停止生成」时会真正掐断 HTTP 请求，不只是前端不显示
   * 3. 过滤空增量后逐个 yield，调用方负责累加保存中断内容
   */
  async *stream(
    messages: ChatMessage[],
    signal?: AbortSignal,
  ): AsyncGenerator<string> {
    const events = await this.model.streamEvents(messages, {
      signal,
      timeout: CHAT_TIMEOUT_MS,
    });
    for await (const delta of events.text) {
      if (delta) yield delta;
    }
  }
}
```

- [ ] **Step 4: 扩展 token 文件**

Modify `apps/api/src/llm/llm.tokens.ts`，追加：

```ts
/** LangChain 聊天模型里我们实际用到的能力（便于测试注入假模型） */
export interface ChatModelProvider {
  streamEvents(
    input: unknown,
    options?: { signal?: AbortSignal; timeout?: number },
  ): Promise<{ text: AsyncIterable<string> }>;
}
```

- [ ] **Step 5: 注册对话 provider**

Modify `apps/api/src/llm/llm.module.ts`，在 providers 追加：

```ts
    {
      provide: CHAT_MODEL_PROVIDER,
      // temperature 固定 0.2：知识库问答要稳定复述资料，不要发挥
      useFactory: (config: AppConfigService) =>
        new ChatOpenAI({
          model: config.llm.model,
          apiKey: config.llm.apiKey,
          configuration: { baseURL: config.llm.baseUrl },
          temperature: 0.2,
          maxTokens: 1500,
          maxRetries: 1,
        }),
      inject: [AppConfigService],
    },
```

并把 `import { ChatOpenAI } from '@langchain/openai';`、`exports` 补上 `ChatModelService`、`CHAT_MODEL_PROVIDER`。

- [ ] **Step 6: 运行确认通过**

Run: `cd apps/api && npm run typecheck && npx jest src/llm`
Expected: 嵌入 3 + 对话 2 全 PASS。

### Task 9 (B3): 解析层改用 LangChain DocumentLoader

**Files:**
- Create: `apps/api/src/ingestion/parsing/pdf-pages.ts`
- Create: `apps/api/src/ingestion/parsing/pdf-pages.spec.ts`
- Modify: `apps/api/src/ingestion/parsing/parser.service.ts`
- Modify: `apps/api/src/ingestion/parsing/parsers.spec.ts`

**Interfaces:**
- Consumes: `StorageService.absolutePath(storageKey)`、`TextParser.parseBuffer(buffer)`
- Produces: `ParserService.load(storageKey: string): Promise<Document[]>`（返回单个元素的数组，交给切分器）；`assertPdfPageCount(total: number): void`

- [ ] **Step 1: 写页数守卫的失败测试**

Create `apps/api/src/ingestion/parsing/pdf-pages.spec.ts`：

```ts
import { BadRequestException } from '@nestjs/common';
import { assertPdfPageCount } from './pdf-pages';

describe('assertPdfPageCount', () => {
  it('超过 200 页直接拒绝（服务器内存只有 1.8GB）', () => {
    expect(() => assertPdfPageCount(201)).toThrow(BadRequestException);
    expect(() => assertPdfPageCount(201)).toThrow(/页数超过 200 页/);
  });

  it('200 页以内放行', () => {
    expect(() => assertPdfPageCount(200)).not.toThrow();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/api && npx jest src/ingestion/parsing/pdf-pages`
Expected: FAIL，找不到 `./pdf-pages`。

- [ ] **Step 3: 实现页数守卫与超时包装**

Create `apps/api/src/ingestion/parsing/pdf-pages.ts`：

```ts
/**
 * PDF 解析的前置保护。
 * 边界：只负责「能不能解析」和「别把进程拖死」，文本提取交给 LangChain 的 PDFLoader。
 * 为什么单独拆出来：PDFLoader 自身没有页数上限与超时概念，直接用它会让超大 PDF
 *                在 1.8GB 内存的机器上把 worker 打爆。
 */
import { BadRequestException } from '@nestjs/common';

/** 页数上限：超过就拒绝，避免超大扫描件耗尽内存 */
export const MAX_PDF_PAGES = 200;

/** 单次 PDF 解析超时（读元数据与正文各算一次） */
export const PDF_PARSE_TIMEOUT_MS = 60_000;

/** 页数校验：total 来自 pdf-parse 的 getInfo()，比整篇解析便宜得多 */
export function assertPdfPageCount(total: number): void {
  if (total > MAX_PDF_PAGES) {
    throw new BadRequestException(`PDF 页数超过 ${MAX_PDF_PAGES} 页`);
  }
}

/** 给任意 promise 加超时，超时后抛普通 Error（由上层统一包成 BadRequestException） */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}超时`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
```

- [ ] **Step 4: 改写解析器测试（先失败）**

Modify `apps/api/src/ingestion/parsing/parsers.spec.ts`，把断言目标从「返回 string」改成「返回 Document[]，且保留错误契约」：

```ts
import { BadRequestException } from '@nestjs/common';
import { PDFDocument } from 'pdfkit';
import { ParserService } from './parser.service';
import { TextParser } from './text.parser';
import { StorageService } from '../../storage/storage.service';

function makePdf(text?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    if (text) doc.text(text);
    doc.end();
  });
}

function buildService(buffer: Buffer) {
  const storage = { absolutePath: () => '', readFile: async () => buffer } as never;
  return new ParserService(storage, new TextParser());
}

describe('ParserService.load', () => {
  it('TXT 走 GB18030 回退，中文不乱码', async () => {
    const iconv = require('iconv-lite');
    const service = buildService(iconv.encode('知识库问答系统', 'gb18030'));
    const docs = await service.load('orgs/a/knowledge-bases/b/documents/c/d.txt');
    expect(docs[0].pageContent).toContain('知识库问答系统');
  });

  it('空白 PDF 报「未包含可提取文本」', async () => {
    const service = buildService(await makePdf());
    await expect(
      service.load('orgs/a/knowledge-bases/b/documents/c/scan.pdf'),
    ).rejects.toThrow(BadRequestException);
  });
});
```

- [ ] **Step 5: 运行确认失败**

Run: `cd apps/api && npx jest src/ingestion/parsing/parsers`
Expected: FAIL，`service.load is not a function`。

- [ ] **Step 6: 用 LangChain loader 重写 ParserService**

Modify `apps/api/src/ingestion/parsing/parser.service.ts` 为：

```ts
/**
 * 文档解析层：把上传的原文件读成 LangChain 的 Document（纯文本 + metadata）。
 * 边界：只负责「读出一个文档」，不切分（splitter）、不嵌入（EmbeddingsService）、不写库。
 * 三种格式的取舍：
 * - TXT/MD：不能用 LangChain TextLoader（只按 UTF-8 读），保留自研解码以支持 GB18030 回退，
 *           解码结果再包成 Document，从而与后续 LangChain 流程衔接
 * - PDF：用 PDFLoader 提取文本，但页数上限与超时由 pdf-pages.ts 在外面守着
 * - DOCX：用 DocxLoader（底层同样是 mammoth），再做归一化与空内容校验
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import { Document } from '@langchain/core/documents';
import { DocxLoader } from '@langchain/community/document_loaders/fs/docx';
import { PDFLoader } from '@langchain/community/document_loaders/fs/pdf';
import { extname } from 'node:path';
import { StorageService } from '../../storage/storage.service';
import { TextParser } from './text.parser';
import { normalizeText } from './normalize';
import {
  assertPdfPageCount,
  PDF_PARSE_TIMEOUT_MS,
  withTimeout,
} from './pdf-pages';

/** 归一化后正文短于这个长度就认为「没有可用文本」（扫描件、空文档） */
const MIN_TEXT_LENGTH = 20;

@Injectable()
export class ParserService {
  constructor(
    private readonly storage: StorageService,
    private readonly textParser: TextParser,
  ) {}

  /**
   * 读取原文件并产出 Document 列表。
   * 步骤：
   * 1. 按扩展名分派；未知格式直接 400（上传接口已有白名单，这里是第二道防线）
   * 2. 提取正文文本（各格式策略见文件头）
   * 3. 统一归一化 + 空内容判定，保证下游切分器拿到的是干净文本
   * 4. 包成单个 Document 返回，metadata.source 记录文件名便于引用展示
   */
  async load(storageKey: string): Promise<Document[]> {
    const extension = extname(storageKey).toLowerCase();
    const absolute = this.storage.absolutePath(storageKey);
    let text: string;

    switch (extension) {
      case '.txt':
      case '.md': {
        // 自研解码：UTF-8 严格失败则按 GB18030 解，避免中文文档乱码
        text = this.textParser.parseBuffer(await this.storage.readFile(storageKey));
        break;
      }
      case '.pdf':
        text = await this.loadPdf(absolute);
        break;
      case '.docx':
        text = await this.loadDocx(absolute);
        break;
      default:
        throw new BadRequestException('不支持的文档格式');
    }

    const normalized = normalizeText(text);
    if (normalized.length < MIN_TEXT_LENGTH) {
      throw new BadRequestException('文档未包含可提取文本');
    }
    return [new Document({ pageContent: normalized, metadata: { source: storageKey } })];
  }

  /**
   * PDF 提取。
   * 步骤：
   * 1. 先只读元数据拿页数（比整篇解析便宜），超限立刻拒绝，避免大文件吃满内存
   * 2. 用 PDFLoader 按页解析（splitPages:true 才能拿到每页边界）
   * 3. 页内文本用换行拼接，交给外层统一归一化
   * 4. 任何非业务异常统一包成 400，让队列按「永久失败」处理而不是无限重试
   */
  private async loadPdf(absolute: string): Promise<string> {
    const { PDFParse } = await import('pdf-parse');
    const probe = new PDFParse({ data: await this.storage.readFileFromAbsolute(absolute) });
    try {
      const info = await withTimeout(probe.getInfo(), PDF_PARSE_TIMEOUT_MS, 'PDF');
      assertPdfPageCount(info.total);
    } finally {
      await probe.destroy().catch(() => undefined);
    }

    try {
      const loader = new PDFLoader(absolute, { splitPages: true });
      const pages = await withTimeout(loader.load(), PDF_PARSE_TIMEOUT_MS, 'PDF');
      return pages.map((page) => page.pageContent).join('\n');
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException(
        `PDF 解析失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** DOCX 提取：DocxLoader 内部用 mammoth 取纯文本，这里只补归一化前的空值判定 */
  private async loadDocx(absolute: string): Promise<string> {
    try {
      const docs = await new DocxLoader(absolute).load();
      return docs.map((doc) => doc.pageContent).join('\n');
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException(
        `DOCX 解析失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
```

- [ ] **Step 7: 给 StorageService 加绝对路径读取**

Modify `apps/api/src/storage/storage.service.ts`，在 `readFile` 下方追加：

```ts
  /**
   * 按已校验的绝对路径读取。
   * 用途：LangChain loader 只接受路径，不接受我们的 storageKey；
   *      路径必须由 absolutePath() 生成过（已含穿越校验），这里不再二次拼接。
   */
  readFileAt(absolute: string): Promise<Buffer> {
    return readFile(absolute);
  }
```

并把 Step 6 里的 `this.storage.readFileFromAbsolute(absolute)` 改名为 `this.storage.readFileAt(absolute)`（保持两处一致）。

- [ ] **Step 8: 运行确认通过**

Run: `cd apps/api && npm run typecheck && npx jest src/ingestion/parsing`
Expected: 解析与页数守卫用例全 PASS。若 `PDFLoader` 在 Jest 下报 `Failed to load pdf-parse`，给 loader 注入自定义 importer：`new PDFLoader(absolute, { splitPages: true, pdfjs: () => import('pdf-parse') })`，并确认测试脚本已带 `--experimental-vm-modules`。

#### Task 9 实现偏差（B3 评审后落地状态，勿照抄上文代码）

评审认定 Step 6/7 的以下两处必须改，最终代码与本节文本不同（历史记录保留不删）：

1. **Step 6 的全局 `MIN_TEXT_LENGTH = 20` 已收窄到只有 PDF 分支**。原写法把 20 字符下限放在 `load()` 里对所有格式统一生效，会让 10 个字的 TXT/MD/DOCX 由 `ready` 变 `failed`，违背「对外行为零变化」。最终：`MIN_TEXT_LENGTH` 只在 `loadPdf()` 的扫描件检测里用（`ingestion/parsing/parser.service.ts:29` 与 `:142-144`）；TXT/MD 只拒绝空内容（`文档内容为空`，`parsing/text.parser.ts:66-68`）；DOCX 只拒绝空内容并保留文案 `DOCX 未包含可提取文本`（`parser.service.ts:165-167`）；`load()` 的兜底改成「归一化后为空即抛 `文档未包含可提取文本`」（`:79-81`）。
2. **Step 7 的 `StorageService.readFileAt` 没有新增，该方法至今不存在**。绝对路径直读会绕过 `absolutePath()` 这道唯一带穿越校验的出口（`storage/storage.service.ts:11` 的文件头就是这么声明的）。最终改为按 storageKey 读：页数探测走已校验的 `readFile(storageKey)`，`PDFLoader` 只吃 `absolutePath(storageKey)` 的结果（`parser.service.ts:62-69`、`:115-119`）。
3. 同时被修正的 Minor（一并记录，免得下次照抄）：页文本用 `join('\n\n')` 而非 `'\n'`，以保住段落边界给切分器（`:139`）；超时 label 统一成「PDF 解析」（`:124`、`:136`）；探测阶段也在 `try` 内，任何非业务异常都包成 `PDF 解析失败：...` 的 400（`:114`、`:146-151`）；`pdf-pages.ts` 的 `PDF_PARSE_TIMEOUT_MS` 注释补上「探测与正文各算一次，不是整篇总预算」（`parsing/pdf-pages.ts:12-13`）。
4. 一处已知回归，按裁定**本任务不补**：`withTimeout` 只约束等待，超时后 pdf.js 仍会继续解析完并持有 buffer——`PDFLoader` 不交出内部 `PDFParse` 实例，它自己的 `finally` 要等 `getText/getInfo` 落定才 `destroy()`（`@langchain/community@1.1.29` `dist/document_loaders/fs/pdf.js:99-100`、`:132-133`）。旧 `PdfParser`（B8 已删）在 `finally` 里立刻 destroy，能打断在途解析。风险目前只由 200 页上限约束（约束页数而非字节数）。详见 `pdf-pages.ts:25-33` 与 `parser.service.ts:100-108` 的注释。

### Task 10 (B4): 切分改用 RecursiveCharacterTextSplitter

**Files:**
- Modify: `apps/api/src/ingestion/parsing/chunker.ts`
- Modify: `apps/api/src/ingestion/parsing/chunker.spec.ts`

**Interfaces:**
- Consumes: `AppConfigService.chunkSize`（800）、`chunkOverlap`（120）
- Produces: `splitToChunks(text: string, size?: number, overlap?: number): Promise<string[]>`（替代原同步 `chunkText`）

- [ ] **Step 1: 改写成不变量断言的测试**

原测试断言了精确切片位置，换 splitter 后边界会变，因此改为断言不变量（长度上限、重叠存在、内容不丢、空输入）：

```ts
import { splitToChunks } from './chunker';

const zh = '知识库问答系统用于企业内部资料检索与回答，支持多种文档格式和团队协作。';

describe('splitToChunks', () => {
  it('空文本返回空数组', async () => {
    expect(await splitToChunks(' \n\n ')).toEqual([]);
  });

  it('每块不超过配置长度', async () => {
    const chunks = await splitToChunks(zh.repeat(10), 100, 20);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 100)).toBe(true);
  });

  it('相邻块之间存在重叠，保证跨块语义不被切断', async () => {
    const chunks = await splitToChunks(zh.repeat(10), 100, 20);
    const shared = chunks[1].slice(0, 10);
    expect(chunks[0]).toContain(shared);
  });

  it('中文标点参与切分（不能只在空格处断句）', async () => {
    const text = `${'第一段内容。'.repeat(12)}${'第二段内容。'.repeat(12)}`;
    const chunks = await splitToChunks(text, 60, 0);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.includes('。') || chunk.length <= 60)).toBe(true);
  });

  it('不丢内容：所有块的字符都来自原文', async () => {
    const chunks = await splitToChunks(zh.repeat(5), 100, 20);
    const original = zh.repeat(5);
    expect(chunks.every((chunk) => original.includes(chunk))).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/api && npx jest src/ingestion/parsing/chunker`
Expected: FAIL，`splitToChunks is not a function`。

- [ ] **Step 3: 用 LangChain 切分器重写**

Modify `apps/api/src/ingestion/parsing/chunker.ts`：

```ts
/**
 * 文本切分：把整篇文档切成带重叠的片段，供嵌入与检索使用。
 * 边界：只做切分，不做解码（parser 层）、不做嵌入（llm 层）。
 */
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { normalizeText } from './normalize';

/**
 * 中文优先的分隔符序列。
 * 原因：LangChain 默认分隔符按空格/句子切，中文几乎没有空格，
 *      不显式配置会把整段塞进一块甚至超过 chunkSize。
 */
const SEPARATORS = ['\n\n', '\n', '。', '！', '？', '；', '，', '、', ' ', ''];

/**
 * 切分文档。
 * 步骤：
 * 1. 先归一化（统一换行、压缩空行），保证切分基线一致
 * 2. 交给 RecursiveCharacterTextSplitter：按分隔符优先级递归切，块长 ≤ size，相邻块重叠 overlap
 * 3. 长度函数用 JS 字符串长度（与配置的 800/120 语义一致，不是 token 数）
 * 4. 过滤空白块，返回纯字符串数组给嵌入层
 */
export async function splitToChunks(
  input: string,
  size = 800,
  overlap = 120,
): Promise<string[]> {
  const text = normalizeText(input);
  if (!text) return [];

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: Math.max(1, size),
    chunkOverlap: Math.max(0, Math.min(overlap, size - 1)),
    separators: SEPARATORS,
    lengthFunction: (value: string) => value.length,
  });

  const docs = await splitter.splitText(text);
  return docs.map((doc) => doc.trim()).filter(Boolean);
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd apps/api && npx jest src/ingestion/parsing/chunker`
Expected: 5 个用例 PASS。若「重叠」用例失败，说明 overlap 被 size 夹到 0，检查参数传递。

### Task 11 (B5): 入库流程接入 LangChain 解析/切分/嵌入

**Files:**
- Modify: `apps/api/src/ingestion/ingestion.service.ts`
- Modify: `apps/api/src/ingestion/ingestion.module.ts`
- Modify: `apps/api/test/ingestion.e2e-spec.ts`
- Modify: `apps/api/src/ingestion/ingestion.processor.ts`（仅当构造签名变化）

**Interfaces:**
- Consumes: `ParserService.load()`（B3）、`splitToChunks()`（B4）、`EmbeddingsService.embed()`（B1）
- Produces: `IngestionService.process(job: IngestJob): Promise<void>` 行为不变（状态流转 + `pg_notify` + 失败语义）

- [ ] **Step 1: 更新 e2e 的 provider 覆盖点**

Modify `apps/api/test/ingestion.e2e-spec.ts`：把 `overrideProvider(LlmService)` 换成嵌入 provider 的假实现，并把断言里的 `fakeLlm.embed` 换成新 fake：

```ts
import { EMBEDDINGS_PROVIDER } from '../src/llm/llm.tokens';

const fakeEmbeddings = {
  embedDocuments: jest.fn(async (texts: string[]) =>
    texts.map(() => Array(1024).fill(0.01)),
  ),
};

// Test.createTestingModule(...) 链上：
      .overrideProvider(EMBEDDINGS_PROVIDER)
      .useValue(fakeEmbeddings)
```

同时把 `expect(fakeLlm.embed).toHaveBeenCalled()` 改为 `expect(fakeEmbeddings.embedDocuments).toHaveBeenCalled()`。

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/api && npm run test:e2e -- ingestion`
Expected: FAIL（`IngestionService` 仍依赖旧 `LlmService`/`ParserService.parse`/`chunkText`）。

- [ ] **Step 3: 改造 IngestionService**

Modify `apps/api/src/ingestion/ingestion.service.ts`，把依赖与流程换成新模块：

```ts
  constructor(
    private readonly db: DatabaseService,
    private readonly parser: ParserService,
    private readonly embeddings: EmbeddingsService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * 处理一份文档的入库。
   * 步骤：
   * 1. 按 orgId + documentId 取文档（带 org 条件，防止跨组织误处理），取不到说明已被删除，直接返回
   * 2. 状态置 processing 并广播（前端实时看到「解析中」）
   * 3. 用 LangChain loader 读出 Document[]，再切成片段（800/120，中文分隔符）
   * 4. 批量嵌入并逐条校验维度，得到与片段一一对应的向量
   * 5. 单事务内：删旧片段 → 批量插入新片段 → 状态置 ready 写 chunk_count
   *    （删+插放同一事务，避免重试时出现半份片段）
   * 6. 广播 ready；失败时状态置 failed 并广播
   * 7. 内容类错误（BadRequestException）不再抛出，避免队列对「扫描件」这类永久问题反复重试
   */
  async process(job: IngestJob): Promise<void> {
```

正文里把 `this.parser.parse(...)` + `chunkText(...)` 替换为：

```ts
      const docs = await this.parser.load(document.storage_key);
      const chunks = await splitToChunks(
        docs.map((doc) => doc.pageContent).join('\n'),
        this.config.chunkSize,
        this.config.chunkOverlap,
      );
      if (!chunks.length) {
        throw new BadRequestException('文档没有可用于切分的内容');
      }
      const embeddings = await this.embeddings.embed(chunks);
```

- [ ] **Step 4: 更新模块依赖**

Modify `apps/api/src/ingestion/ingestion.module.ts`：确认 `imports` 里有 `LlmModule`（全局模块则无需显式引入），`providers` 保留 `ParserService`、`TextParser`，删除 `PdfParser`、`DocxParser`（B8 才删文件，本步先解除引用）。

- [ ] **Step 5: 运行确认通过**

Run: `cd apps/api && npm run test:e2e -- ingestion`
Expected: 2 个用例 PASS（含「空白 PDF → failed 且 error 含『未包含可提取文本』」）。若该断言失败，检查 B3 里统一空文本消息是否覆盖了 PDF 分支。

- [ ] **Step 6: 验证闸口**

Run: `cd apps/api && npm run typecheck && npm test && npm run test:e2e`
Expected: 全绿。

### Task 12 (B6): 自定义 KbRetriever（保留现有 pgvector SQL）

**Files:**
- Create: `apps/api/src/chat/kb.retriever.ts`
- Create: `apps/api/src/chat/kb.retriever.spec.ts`
- Modify: `apps/api/src/chat/sources.ts`

**Interfaces:**
- Consumes: `RetrievalService.retrieve(orgId, kbId, question, signal)`
- Produces:
  - `class KbRetriever extends BaseRetriever`，构造 `(retrieval: RetrievalService, options: { orgId: string; kbId: string; signal?: AbortSignal })`
  - `toSource(document: Document): Source`

- [ ] **Step 1: 写失败的 retriever 测试**

Create `apps/api/src/chat/kb.retriever.spec.ts`：

```ts
import { KbRetriever } from './kb.retriever';
import { toSource } from './sources';

const source = {
  index: 1,
  documentId: 'd1',
  filename: 'a.md',
  chunkId: 'c1',
  chunkIndex: 0,
  score: 0.87,
  content: '资料内容',
};

describe('KbRetriever', () => {
  it('把检索结果转成带 metadata 的 LangChain Document', async () => {
    const retrieval = { retrieve: jest.fn().mockResolvedValue([source]) };
    const retriever = new KbRetriever(retrieval as never, { orgId: 'o1', kbId: 'k1' });

    const docs = await retriever.getRelevantDocuments('问题');

    expect(retrieval.retrieve).toHaveBeenCalledWith('o1', 'k1', '问题', undefined);
    expect(docs[0].pageContent).toBe('资料内容');
    expect(docs[0].metadata).toMatchObject({ index: 1, filename: 'a.md', score: 0.87 });
  });

  it('toSource 能从 Document 还原出前端需要的引用结构', async () => {
    const retrieval = { retrieve: jest.fn().mockResolvedValue([source]) };
    const retriever = new KbRetriever(retrieval as never, { orgId: 'o1', kbId: 'k1' });
    const [doc] = await retriever.getRelevantDocuments('问题');
    expect(toSource(doc)).toEqual(source);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/api && npx jest src/chat/kb.retriever`
Expected: FAIL，找不到 `./kb.retriever`。

- [ ] **Step 3: 实现 retriever 与映射**

Create `apps/api/src/chat/kb.retriever.ts`：

```ts
/**
 * 知识库检索器：LangChain BaseRetriever 的自定义实现。
 * 为什么不用 PGVectorStore：它要求由自己建表（id/content/metadata jsonb/embedding），
 *   会丢掉 org_id/kb_id/document_id/chunk_index 这些强约束列、无法 JOIN documents.status，
 *   多租户隔离会从「数据库列」降级成 JSONB 文本比较。
 * 因此这里保留手写 pgvector SQL（RetrievalService），只套一层 LangChain 外壳，
 *   让检索能作为标准 Runnable 接入链，同时隔离与状态过滤不降级。
 */
import { Document } from '@langchain/core/documents';
import { BaseRetriever } from '@langchain/core/retrievers';
import { RetrievalService } from './retrieval.service';

export interface KbRetrieverOptions {
  orgId: string;
  kbId: string;
  signal?: AbortSignal;
}

export class KbRetriever extends BaseRetriever {
  lc_namespace = ['knowledge-rag', 'chat'];

  constructor(
    private readonly retrieval: RetrievalService,
    private readonly options: KbRetrieverOptions,
  ) {
    super();
  }

  /**
   * LangChain 约定的实现点。
   * 步骤：
   * 1. 委托 RetrievalService：向量 Top-K + 阈值过滤 + 编号都在 SQL 层完成
   * 2. 把每条结果包成 Document：pageContent 是片段原文，metadata 带引用所需的全部字段
   * 3. orgId/kbId 在构造时绑定（每次请求新建实例），杜绝跨请求串租户
   */
  protected async _getRelevantDocuments(query: string): Promise<Document[]> {
    const sources = await this.retrieval.retrieve(
      this.options.orgId,
      this.options.kbId,
      query,
      this.options.signal,
    );
    return sources.map(
      (source) =>
        new Document({
          pageContent: source.content,
          metadata: { ...source },
        }),
    );
  }
}
```

Modify `apps/api/src/chat/sources.ts`，追加：

```ts
/**
 * Document → 前端引用结构。
 * 与 KbRetriever 的 metadata 一一对应；单独导出是为了让「检索产物」和「落库/推送格式」
 * 只在这里转换一次，避免多处手工取字段导致引用错位。
 */
export function toSource(document: Document): Source {
  const { metadata } = document;
  return {
    index: metadata.index,
    documentId: metadata.documentId,
    filename: metadata.filename,
    chunkId: metadata.chunkId,
    chunkIndex: metadata.chunkIndex,
    score: metadata.score,
    content: document.pageContent,
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd apps/api && npm run typecheck && npx jest src/chat/kb.retriever`
Expected: 2 个用例 PASS。

### Task 13 (B7): LCEL 提示链并接入 ChatService

**Files:**
- Create: `apps/api/src/chat/rag-prompt.ts`
- Create: `apps/api/src/chat/rag-prompt.spec.ts`
- Modify: `apps/api/src/chat/chat.service.ts`
- Modify: `apps/api/src/chat/chat.service.spec.ts`
- Modify: `apps/api/src/chat/chat.module.ts`
- Delete: `apps/api/src/chat/prompt.service.ts`、`prompt.service.spec.ts`（本任务内完成替换后删）

**Interfaces:**
- Consumes: `KbRetriever`（B6）、`ChatModelService`（B2）、`Source`
- Produces: `buildRagMessages(history: ChatMessage[], sources: Source[], question: string): Promise<ChatMessage[]>`、`formatNumberedContext(sources: Source[]): string`

- [ ] **Step 1: 写提示链测试（先失败）**

Create `apps/api/src/chat/rag-prompt.spec.ts`：

```ts
import { buildRagMessages, formatNumberedContext } from './rag-prompt';

const source = {
  index: 1,
  documentId: 'd1',
  filename: '手册.md',
  chunkId: 'c1',
  chunkIndex: 3,
  score: 0.9,
  content: '发布代号是 Atlas',
};

describe('rag-prompt', () => {
  it('上下文带引用编号与片段位置，供模型输出 [1] 标注', async () => {
    const context = formatNumberedContext([source]);
    expect(context).toContain('[1] 文件：手册.md（片段 3）');
    expect(context).toContain('发布代号是 Atlas');
  });

  it('无资料时给出明确的空上下文标记', async () => {
    expect(formatNumberedContext([])).toContain('没有检索到相关资料');
  });

  it('消息顺序为 system → history → 当前问题', async () => {
    const messages = await buildRagMessages(
      [{ role: 'user', content: '上一轮' }],
      [source],
      '发布代号是什么？',
    );
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('参考资料：');
    expect(messages[messages.length - 1]).toEqual({
      role: 'user',
      content: '发布代号是什么？',
    });
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/api && npx jest src/chat/rag-prompt`
Expected: FAIL，找不到 `./rag-prompt`。

- [ ] **Step 3: 用 ChatPromptTemplate 实现提示链**

Create `apps/api/src/chat/rag-prompt.ts`：

```ts
/**
 * RAG 提示编排：把「检索到的片段 + 历史 + 当前问题」组装成模型消息。
 * 边界：不检索、不调模型，只负责提示词，方便单独回归引用格式。
 * 用 LangChain ChatPromptTemplate 而不是手拼数组，是为了让消息模板可复用、
 * 变量缺失时由框架报错而不是静默拼出错误提示。
 */
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { ChatMessage } from '../llm/llm.types';
import { Source } from './sources';

const SYSTEM_PROMPT = `你是知识库问答助手。只能依据提供的资料回答，不得编造资料中没有的信息。
回答时在相关句子后标注来源编号，例如 [1]、[2]。
如果资料不足以回答，请明确说明“知识库中没有找到足够的信息”，并给出可能的下一步建议。
使用与用户问题相同的语言回答，保持简洁、准确。`;

/** 只保留最近 6 条历史，再多会挤占资料上下文并抬高延迟 */
const HISTORY_LIMIT = 6;

/** system 模板：{context} 由 formatNumberedContext 预先拼好，避免把用户内容当模板变量 */
const prompt = ChatPromptTemplate.fromMessages([
  ['system', `${SYSTEM_PROMPT}\n\n参考资料：\n{context}`],
  ['placeholder', '{history}'],
  ['human', '{question}'],
]);

/**
 * 拼接带编号的资料块。
 * 步骤：
 * 1. 每条资料一行头：[编号] 文件：xxx（片段 n），后换行接正文
 * 2. 编号直接用检索阶段分配好的 index，保证与前端引用卡片一致
 * 3. 空列表返回固定提示，让模型明确「没资料」而不是瞎编
 */
export function formatNumberedContext(sources: Source[]): string {
  if (!sources.length) return '（没有检索到相关资料）';
  return sources
    .map(
      (source) =>
        `[${source.index}] 文件：${source.filename}（片段 ${source.chunkIndex}）\n${source.content}`,
    )
    .join('\n\n');
}

/**
 * 构造模型消息。
 * 步骤：
 * 1. 历史转成 LangChain 消息占位（MessagesPlaceholder），保持 user/assistant 交替
 * 2. 用模板渲染并取回 OpenAI 形状的消息（role/content），供 ChatModelService 直接发送
 */
export async function buildRagMessages(
  history: ChatMessage[],
  sources: Source[],
  question: string,
): Promise<ChatMessage[]> {
  const { MessagesPlaceholder } = await import('@langchain/core/prompts');
  const template = ChatPromptTemplate.fromMessages([
    ['system', `${SYSTEM_PROMPT}\n\n参考资料：\n{context}`],
    new MessagesPlaceholder('history'),
    ['human', '{question}'],
  ]);
  const formatted = await template.format({
    context: formatNumberedContext(sources),
    history: history.slice(-HISTORY_LIMIT).map((item) =>
      item.role === 'assistant'
        ? new (require('@langchain/core/messages').AIMessage)(item.content)
        : new (require('@langchain/core/messages').HumanMessage)(item.content),
    ),
    question,
  });
  return formatted.map((message) => ({
    role: message.getType() === 'ai' ? 'assistant' : 'user',
    content: typeof message.content === 'string'
      ? message.content
      : String(message.content),
  }));
}
```

注意：文件内保留的 `prompt` 常量若与 `buildRagMessages` 内的模板重复，删除顶层 `prompt` 常量，只留函数内构造（实现时二选一，不得留死代码）。

- [ ] **Step 4: ChatService 接入检索器与链**

Modify `apps/api/src/chat/chat.service.ts`：

```ts
  constructor(
    private readonly conversations: ConversationsRepository,
    private readonly messages: MessagesRepository,
    private readonly retrieval: RetrievalService,
    private readonly chatModel: ChatModelService,
    private readonly kbAccess: KbAccessService,
  ) {}
```

`run()` 中把检索与生成两段换成：

```ts
    // 步骤 3：LangChain 检索器召回片段（只检索一次，结果同时用于引用展示与提示词）
    const retriever = new KbRetriever(this.retrieval, {
      orgId: params.orgId,
      kbId: params.kbId,
      signal: params.signal,
    });
    const documents = await retriever.getRelevantDocuments(params.question);
    const sources = documents.map(toSource);

    // 步骤 5：提示编排 + 流式生成（引用先到，再逐 token 推送）
    const prompt = await buildRagMessages(history, sources, params.question);
    let answer = '';
    try {
      for await (const delta of this.chatModel.stream(prompt, params.signal)) {
        answer += delta;
        params.onDelta(delta);
      }
    } catch (error) {
      // 中断/失败时保留已生成内容：用户看到的半条回答必须能落库
```

其余分支（无结果固定回答、半条落库、`interrupted` 标记、空回答不入库）保持原逻辑与返回结构完全不变。

- [ ] **Step 5: 更新 ChatService 单测**

Modify `apps/api/src/chat/chat.service.spec.ts`：构造参数改为 `(conversations, messages, retrieval, chatModel, kbAccess)`；`retrieval.retrieve` 返回 `[]` 表示无资料；有资料场景用 `retrieve` 返回原 `source` 对象（retriever 内部会包成 Document），并把 `llm.streamChat` 换成 `chatModel.stream`。断言保持不变：`result.answer === '你好'`、`onDelta` 收到 `['你','好']`、`messages.insert` 最后一次带 `sources: [source]`。

- [ ] **Step 6: 更新 e2e 覆盖点**

Modify `apps/api/test/realtime.e2e-spec.ts`：把 `overrideProvider(LlmService)` 换成

```ts
      .overrideProvider(EMBEDDINGS_PROVIDER)
      .useValue({ embedDocuments: async (texts: string[]) => texts.map(() => Array(1024).fill(0.01)) })
      .overrideProvider(CHAT_MODEL_PROVIDER)
      .useValue({
        streamEvents: async () => ({
          text: {
            async *[Symbol.asyncIterator]() {
              yield '回答';
              yield '内容';
            },
          },
        }),
      })
```

- [ ] **Step 7: 运行确认通过**

Run: `cd apps/api && npm run typecheck && npx jest src/chat && npm run test:e2e -- conversations realtime`
Expected: 单测与两个 e2e suite 全绿。

- [ ] **Step 8: 删除旧提示服务**

Delete `apps/api/src/chat/prompt.service.ts` 与 `prompt.service.spec.ts`，并从 `chat.module.ts` 的 providers 中移除 `PromptService`。

Run: `cd apps/api && npm run test:e2e`
Expected: 9 个 suite 全绿。

### Task 14 (B8): 删除旧实现并全量回归

**Files:**
- Delete: `apps/api/src/llm/llm.service.ts`、`sse-parser.ts`、`sse-parser.spec.ts`
- Delete: `apps/api/src/ingestion/parsing/pdf.parser.ts`、`docx.parser.ts`
- Modify: `apps/api/src/llm/llm.module.ts`（移除 LlmService）
- Modify: 任何仍引用 `LlmService`/`chunkText` 的文件

- [ ] **Step 1: 找出全部残留引用**

Run: `cd apps/api && grep -rn "LlmService\|chunkText\|sse-parser\|PdfParser\|DocxParser" src test --include=*.ts`
Expected: 输出仅剩待删文件自身；若 `chat.service.ts` 等仍在引用，先改引用再删。

- [ ] **Step 2: 删除文件并清理模块**

删除上述 5 个文件；`llm.module.ts` 的 providers/exports 去掉 `LlmService`；`ingestion.module.ts` 去掉 `PdfParser`/`DocxParser`。

- [ ] **Step 3: 全量回归**

Run:
```bash
cd apps/api && npm run typecheck && npm test && npm run test:e2e && npm run build
cd apps/web && npm run typecheck && npx vitest run && npm run build
```
Expected: 后端类型检查通过、单测全绿（数量因删除 sse-parser.spec 减少、因新增 embeddings/chat-model/retriever/rag-prompt 增加）、9 个 e2e suite 全绿、两端构建成功。

- [ ] **Step 4: 真实模型冒烟（本地 dev 库）**

Run: `cd apps/api && npm run migrate && node dist/main.js`（后台），然后用 curl 走一遍：注册 → 建知识库 → 上传含中文的 txt → 轮询 `GET /api/orgs/:orgId/knowledge-bases/:kbId/documents` 直到 `status=ready` 且 `chunk_count>0` → 调对话接口确认流式回答带 `[1]` 引用。
Expected: 全流程成功（这一步会真调 SiliconFlow，验证 baseURL/鉴权/维度未被 LangChain 改坏）。
随后清理本次 dev 库测试数据（只删自己建的账号与组织）。

### Task 15 (B9): 部署到生产并验收

**Files:**
- Modify: `docs/deployment-record.md`
- Sync: 项目源码到 `/opt/knowledge-rag`

- [ ] **Step 1: 同步源码（含锁文件）**

```bash
cd /c/Users/Administrator/Desktop/project/knowledge-rag && tar -czf - \
  --exclude='node_modules' --exclude='apps/web/dist' --exclude='apps/api/dist' \
  --exclude='.env' --exclude='apps/api/storage' --exclude='apps/api/test/tmp-uploads' \
  . | ssh <SSH_HOST> 'mkdir -p /opt/knowledge-rag && tar -xzf - -C /opt/knowledge-rag'
```

- [ ] **Step 2: 构建前检查内存（1.8GB 机器，依赖变多）**

Run: `ssh <SSH_HOST> 'free -m && swapon --show'`
Expected: 可用内存 + swap 足以撑住 `npm ci`；不足则先停掉非必要自建容器（**不得动 xflow/travel/pgvector/my-mysql**），或加 swap 后再构建——加 swap 属于系统改动，需先征得同意。

- [ ] **Step 3: 串行构建 API 镜像**

Run: `ssh <SSH_HOST> 'cd /opt/knowledge-rag/deploy && docker compose --env-file .env.production -p knowledge-rag build api 2>&1 | tail -5'`
Expected: 构建成功；若 OOM，看日志定位，不要并行构建、不要 prune。

- [ ] **Step 4: 迁移与滚动重启**

```bash
ssh <SSH_HOST> 'cd /opt/knowledge-rag/deploy && docker compose --env-file .env.production -p knowledge-rag up -d migrate && sleep 5 && docker compose --env-file .env.production -p knowledge-rag logs --tail=5 migrate'
ssh <SSH_HOST> 'cd /opt/knowledge-rag/deploy && docker compose --env-file .env.production -p knowledge-rag up -d --force-recreate --no-deps api worker && sleep 6 && curl -fsS http://127.0.0.1:8088/api/health'
```
Expected: migrate 日志无新迁移（001/002 已应用）；health 返回 `{"status":"ok","db":"ok","queue":"ok"}`。

- [ ] **Step 5: 生产只读验收**

Run:
```bash
ssh <SSH_HOST> 'docker exec pgvector psql -U postgres -d knowledge_rag -tAc "SELECT (SELECT count(*) FROM users),(SELECT count(*) FROM organizations),(SELECT count(*) FROM knowledge_bases),(SELECT count(*) FROM documents),(SELECT count(*) FROM chunks),(SELECT min(vector_dims(embedding)) FROM chunks);"'
```
Expected: 用户/组织/知识库/文档数不少于部署前基线，`chunks` 数量不变，维度仍为 1024（证明没有误删或重嵌入生产数据）。

- [ ] **Step 6: 真实问答验收**

用浏览器在生产站（`http://<SERVER_IP>:8088`，Ctrl+F5 强刷）对已有文档提一个问题，确认流式回答、引用编号、片段展开、停止生成均正常。**不创建生产账号、不上传生产文档**。

- [ ] **Step 7: 更新文档**

`docs/deployment-record.md` 追加「第六批：RAG 链路改用 LangChain」条目，记录依赖版本、镜像重建范围、验收结果、回滚方式（指回上一版 `knowledge-rag-api:local` tag）。

---

## Phase C：测试文件注释与收尾

### Task 16 (C1): 测试文件补中文注释

**Files:**
- Modify: `apps/api/test/*.e2e-spec.ts`（9 个）
- Modify: `apps/api/src/**/*.spec.ts`（迁移后的全部单测）
- Modify: `apps/web/src/**/*.spec.ts`（2 个）

- [ ] **Step 1: 每个测试文件加文件头**

说明「这个 suite 守的是哪条行为契约」，并逐用例注释断言的意图。重点是不可回退的回归点：

```ts
/**
 * 入库链路 e2e：验证「上传 → 解析 → 切分 → 嵌入 → 写库 → 广播」整条流水线。
 * 这里用假的 EMBEDDINGS_PROVIDER，绝不打真实模型服务：CI 不能依赖外部网络与额度。
 */
```

```ts
  // 回归点：空白 PDF 必须以「未包含可提取文本」失败，
  // 换成 LangChain PDFLoader 后这条契约最容易丢，所以断言写死错误文案
```

- [ ] **Step 2: 验证闸口**

Run: `cd apps/api && npm test && npm run test:e2e && cd ../web && npm run typecheck && npx vitest run`
Expected: 全绿。

### Task 17 (C2): 文档同步

**Files:**
- Modify: `docs/superpowers/specs/2026-10-23-langchain-migration-design.md`（状态改为「已实现」）
- Modify: `README.md`、`docs/operations.md`（依赖与模型层说明、排障要点）
- Modify: `deploy/DEPLOY.md`（构建内存注意事项更新）

- [ ] **Step 1: 更新说明并同步服务器**

把「RAG 链路 = LangChain 抽象 + 自研 pgvector 检索」写进 README 架构段；`docs/operations.md` 增加排障条目：PDF 页数超限、`Embedding 维度不正确`、`streamEvents` 中断行为分别看哪个文件。

Run: `scp` 或 tar 同步文档到 `/opt/knowledge-rag/docs`（不影响容器）。
Expected: 服务器文档与本地一致。

## Self-Review

1. **Spec 覆盖**：spec §2.1（自定义 Retriever）→ B6；§2.2（LCEL，无 RetrievalQA）→ B7；§2.3（TXT/MD 保留解码）→ B3 Step 6；§3（版本与 CJS/Node 约束）→ B1 Step 1 + Global Constraints；§5.1（嵌入批量/维度、对话流式/超时）→ B1/B2；§5.2（loader + 中文分隔符 + 空内容契约）→ B3/B4；§5.3（检索只一次、编号一致、中断半条落库）→ B6/B7；§5.4（错误语义）→ B3/B5；§6（测试策略与假模型）→ B1–B8 各步 + C1；§7（部署与回滚）→ B9；§9（注释规范）→ Phase A + Phase B 内联 + C1。无遗漏。
2. **占位符扫描**：无 TBD/「类似 Task N」；每步含实际命令与代码。
3. **类型一致性**：`EmbeddingsService.embed(inputs, signal)` 在 B5 使用一致；`ChatModelService.stream(messages, signal)` 在 B7 使用一致；`KbRetriever(retrieval, {orgId,kbId,signal})` 在 B6 测试与 B7 使用一致；`toSource(document)` 只在 B6 定义、B7 使用；`splitToChunks(text,size,overlap)` 在 B4 定义、B5 使用；`EMBEDDINGS_PROVIDER`/`CHAT_MODEL_PROVIDER` 常量名在 B1/B2/B5/B7 一致。~~B3 Step 6 与 Step 7 的存储方法名已统一为 `readFileAt`~~（C2 更正：`readFileAt` 在 B3 评审后被废弃，最终代码里没有这个方法，PDF 探测走 `StorageService.readFile(storageKey)`，详见 Task 9 的「实现偏差」）。
