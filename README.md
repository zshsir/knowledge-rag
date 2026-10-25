# Knowledge RAG

多租户知识库问答平台：上传文档即自动解析、切分、向量化，在知识库范围内做检索增强问答（RAG），回答带可回溯的引用来源。

后端 NestJS + PostgreSQL/pgvector，前端 React，链路抽象层使用 LangChain，异步入库走 pg-boss，问答结果通过 WebSocket 逐字流式推送。

## 功能

**账号与组织**

- 邮箱密码登录，服务端 Session（httpOnly Cookie），开放注册开关与邀请链接
- 一个用户可属于多个组织，前端随时切换
- 组织角色 Owner / Admin / Member，分级管理成员与邀请

**知识库**

- 知识库增删改查；两种访问模式：组织公开、指定成员
- 知识库成员三级权限：查看、编辑、管理
- 成员邀请：组织内成员直接勾选加入；非组织成员可由创建者/管理员按邮箱添加——已注册用户会被拉入组织并同时获得知识库授权，未注册用户收到一次性的知识库邀请链接
- 权限变更实时生效：被移出的连接会立即收到 `kb:access-revoked` 并被踢出会话房间

**文档与问答**

- 支持 TXT / MD / PDF / DOCX，原文件存储与鉴权下载
- 异步解析 → 切分 → 嵌入 → 入库，文档状态通过 WebSocket 实时推送
- 流式问答、随时停止生成、引用卡片跳转原文
- 检索严格限制在 `org_id + kb_id` 范围内；会话是用户私有的，团队知识库里的对话互不可见

## 技术栈

| 层 | 选型 |
|---|---|
| 前端 | React 19、Vite、TypeScript、Tailwind CSS 4、TanStack Query、Socket.IO Client、react-markdown |
| 后端 | NestJS 11、LangChain 1（`@langchain/core` / `openai` / `community` / `textsplitters`）、pg、pg-boss 11、Socket.IO、bcryptjs、class-validator |
| 数据 | PostgreSQL 15 + pgvector（HNSW 余弦索引） |
| 模型 | 任意 OpenAI 兼容端点；默认示例为 BAAI/bge-m3（1024 维嵌入）+ 对话模型 |
| 部署 | Docker Compose + Nginx |

## 架构

```text
浏览器 ──HTTP──> NestJS API ──SQL──> PostgreSQL + pgvector
   │                 │                    ▲
   └──WebSocket──────┤                    │
                     └──pg-boss──> Worker ─┘（解析 / 切分 / 嵌入）
```

RAG 链路的抽象层是 LangChain，但**向量存储仍是自研 SQL**：`org_id / kb_id / document_id / chunk_index` 都是独立列，检索要 JOIN `documents` 并过滤 `status = 'ready'`，官方 `PGVectorStore` 接管不了这些约束，所以用自定义 `BaseRetriever` 包住手写查询。

| 环节 | 实现 | LangChain 抽象 |
|---|---|---|
| 解析 | `ParserService.load()`，每份文件产出 `Document[]`；PDF 先探测页数再解析 | `Document`、`PDFLoader`、`DocxLoader`；TXT/MD 保留自研解码（UTF-8 严格失败 → GB18030 回退） |
| 切分 | `splitToChunks()`，大小由 `CHUNK_SIZE` / `CHUNK_OVERLAP` 控制 | `RecursiveCharacterTextSplitter` + 中文分隔符 |
| 嵌入 | `EmbeddingsService.embed()`，每 16 条一批，逐批校验条数与维度 | `OpenAIEmbeddings` |
| 检索 | `KbRetriever` + `RetrievalService` 的 SQL：按组织/知识库过滤、只取 ready、计算 `1 - 余弦距离`；阈值过滤与 1..n 编号在 SQL 之后的 JS 层完成 | 自定义 `BaseRetriever`，经 `invoke()` 调用 |
| 提示与生成 | `buildRagMessages()` 编排提示，`ChatModelService.stream()` 逐 token 输出；中断后的落库与收尾由 `ChatService.run()` 命令式控制 | `ChatPromptTemplate`、`MessagesPlaceholder`、`ChatOpenAI.streamEvents` |

## 权限模型

组织角色：

| 角色 | 能力 |
|---|---|
| Owner | 组织设置、成员角色、邀请、全部知识库管理 |
| Admin | 邀请与移除普通成员、全部知识库管理 |
| Member | 使用组织公开知识库；管理自己创建的知识库 |

知识库有效权限按以下顺序判定，先命中者生效：

1. 组织 Owner / Admin → 管理
2. 知识库创建者 → 管理
3. 显式授权 → 查看 / 编辑 / 管理
4. 知识库为组织公开 → 查看
5. 否则不可见（对外统一表现为「不存在」）

所有业务查询都带 `org_id` 条件，HTTP 与 WebSocket 两条通道各自独立校验权限。

## 快速开始

前置条件：

- Node.js 22+（本项目在 Node 24 下开发）
- PostgreSQL 15+，并安装 `pgvector` 扩展

```bash
# 1. 安装依赖
npm install

# 2. 创建数据库并写入 .env（见下表），然后建表
createdb rag_dev
npm run db:migrate

# 3. 启动 API + Worker + 前端
npm run dev
```

| 服务 | 地址 |
|---|---|
| 前端 | http://localhost:5173 |
| API | http://localhost:3300 |
| 健康检查 | http://localhost:3300/api/health |

`npm run dev` 会并行启动 Nest API、入库 Worker 和 Vite。Worker 开发态使用 `ts-node`（`tsx` 不生成 Nest DI 所需的 decorator metadata）。

## 配置

参考仓库中的 `deploy/.env.production.example`，本地最小示例：

```dotenv
PORT=3300
APP_ORIGIN=http://localhost:5173
COOKIE_SECURE=false
REGISTRATION_ENABLED=true

# 模型（OpenAI 兼容端点）
API_KEY=sk-...
BASE_URL=https://api.siliconflow.cn/v1
MODEL=deepseek-ai/DeepSeek-V4.1-Flash
EMBEDDING_MODEL=BAAI/bge-m3
EMBEDDING_DIMENSIONS=1024

# 数据库
DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=...
DB_NAME=rag_dev
DB_SSL=false

# 存储与切分
UPLOAD_DIR=./storage
MAX_UPLOAD_MB=20
CHUNK_SIZE=800
CHUNK_OVERLAP=120

# 检索与运行时
RETRIEVAL_TOP_K=6
RETRIEVAL_MIN_SCORE=0.2
SESSION_TTL_DAYS=7
WORKER_CONCURRENCY=1
BCRYPT_ROUNDS=12
```

必填项缺失会直接拒绝启动：`DB_HOST` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` / `APP_ORIGIN` / `API_KEY` / `BASE_URL`。

数值项配错同样拒绝启动（而不是静默降级），规则如下：

| 变量 | 规则 | 配错的静默后果（之所以要拦） |
|---|---|---|
| `CHUNK_SIZE` | ≥1 的整数 | 空值得到 0 → 每块只前进 1 个字符 |
| `CHUNK_OVERLAP` | ≥0 的整数，且小于 `CHUNK_SIZE` | 等于片段长度 → 切分不前进 |
| `RETRIEVAL_MIN_SCORE` | >0 且 ≤1 的有限数字 | NaN → 任何片段都不达标，每次提问都回「没找到资料」 |
| `RETRIEVAL_TOP_K` | ≥1 的整数 | 空值得到 0 → `LIMIT 0`，同样是静默无结果 |
| `MAX_UPLOAD_MB` | ≥1 的整数 | NaN → 体积校验永不触发 |
| `WORKER_CONCURRENCY` | ≥1 的整数 | NaN → 注册 0 个 worker，进程活着但不取任务 |
| `SESSION_TTL_DAYS` | ≥1 的整数 | NaN → 会话到期时间写成 Invalid Date |
| `BCRYPT_ROUNDS` | 4..31 的整数 | 非法值会被 bcryptjs 静默降级（如 NaN → cost 10），悄悄弱化哈希 |

> 空值与漏配不同：整行不写会使用默认值；写了空串/纯空白则判非法（`CHUNK_OVERLAP=` 是唯一例外，0 表示不重叠）。

## 常用脚本

```bash
npm run dev          # 并行启动 API、Worker、Web
npm run build        # 构建后端与前端
npm run typecheck    # 两端类型检查
npm run test         # 后端单测 + 前端 Vitest
npm run test:e2e -w @knowledge-rag/api   # 后端 e2e（自动迁移测试库）
npm run db:migrate   # 执行数据库迁移
```

## API 概览

所有接口以 `/api` 为前缀，除注册/登录/健康检查外均需登录。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/auth/register` `/auth/login` `/auth/logout` | 注册、登录、登出 |
| GET | `/auth/me` | 当前用户与所属组织 |
| POST | `/auth/password` | 修改密码 |
| POST | `/orgs` | 创建组织 |
| PATCH | `/orgs/:orgId` | 组织设置 |
| GET/PATCH/DELETE | `/orgs/:orgId/members[/:userId]` | 成员列表、角色调整、移除 |
| GET/POST | `/orgs/:orgId/invites` | 组织邀请列表与创建 |
| DELETE | `/orgs/:orgId/invites/:inviteId` | 撤销邀请 |
| GET/POST | `/invites/:token`、`/invites/:token/accept` | 查看与接受邀请 |
| GET/POST/PATCH/DELETE | `/orgs/:orgId/knowledge-bases[/:kbId]` | 知识库 CRUD |
| GET/POST/PATCH/DELETE | `/orgs/:orgId/knowledge-bases/:kbId/members[/:userId]` | 知识库成员与授权 |
| GET/POST | `/orgs/:orgId/knowledge-bases/:kbId/documents` | 文档列表与上传 |
| GET | `/documents/:documentId/chunks`、`/documents/:documentId/download` | 片段调试、原文下载 |
| DELETE/POST | `/documents/:documentId`、`/documents/:documentId/retry` | 删除文档、失败重试 |
| GET/POST | `/orgs/:orgId/knowledge-bases/:kbId/conversations` | 会话列表与新建 |
| GET/DELETE | `/conversations/:conversationId/messages`、`/conversations/:conversationId` | 读取消息、删除会话 |

WebSocket 事件：

- 客户端 → 服务端：`kb:join`、`kb:leave`、`chat:send`、`chat:cancel`
- 服务端 → 客户端：`chat:meta`、`chat:delta`、`chat:done`、`chat:error`、`document:status`、`kb:access-revoked`

## 测试

```bash
npm run typecheck
npm run test                              # 后端 106 个单测 + 前端 9 个测试
npm run test:e2e -w @knowledge-rag/api    # 31 个 e2e（9 个 suite）
npm run build
```

e2e 通过 `cross-env` 固定使用独立的 `DB_NAME`，不会影响开发库；运行前会自动执行迁移。PDF 解析相关用例需要 `NODE_OPTIONS=--experimental-vm-modules`，相关脚本已内置。

## 目录结构

```text
apps/
  api/
    src/
      auth/            登录、会话、密码
      organizations/   组织、成员、邀请
      knowledge-bases/ 知识库、授权、成员
      documents/       上传、下载、状态
      ingestion/       解析 → 切分 → 嵌入（Worker 消费）
      llm/             嵌入服务、对话模型服务、DI 令牌
      chat/            检索、提示编排、流式问答
      realtime/        WebSocket 网关与事件
      queue/           pg-boss 封装
      storage/         本地文件存储
      config/          环境变量与启动校验
      database/        连接池、迁移、仓储
    test/              e2e 与测试工具
    migrations/        SQL 迁移
  web/
    src/
      app/             路由、布局、鉴权守卫
      features/        认证、知识库、文档、聊天等页面
      components/      设计系统组件
      lib/             API 客户端、Socket、类型
deploy/               Docker Compose、Nginx、生产 env 示例
docs/                 设计文档与运维手册
```

## 已知限制

- 嵌入请求本身不可取消：用户点「停止生成」时调用方立即解阻，但上游 HTTP 仍会在后台跑完（`OpenAIEmbeddings` 没有受支持的 abort 通道）
- PDF 解析超时只能让调用方提前返回，无法中断 pdf.js 已经在进行的工作
- 启动时不交叉校验 `EMBEDDING_DIMENSIONS` 与 `vector(1024)` 列定义；更换嵌入模型需要同步改迁移并重建全部向量
- `@langchain/community` 上游已标记废弃；目前只用它提供的 PDF/DOCX loader，后续可换回 `pdf-parse` / `mammoth` 直接调用

## 安全说明

- `.env` 与生产环境变量文件不进入仓库、镜像或构建上下文
- 所有业务查询按 `org_id` 过滤，服务端在 HTTP 与 WebSocket 两侧重复校验权限
- 上传文件校验扩展名、MIME、魔数与大小；下载走鉴权接口
- Session Cookie 使用 `httpOnly + SameSite=Lax`，写请求校验 Origin
- 生产环境应启用 HTTPS 并设置 `COOKIE_SECURE=true`

## 许可证

本项目采用 [MIT License](LICENSE) 开源，可自由使用、修改、分发与商用，保留版权声明即可。

## 联系

- 邮箱：995801887@qq.com
- GitHub：[@zshsir](https://github.com/zshsir)

欢迎通过 Issue 反馈问题或提出改进建议。
