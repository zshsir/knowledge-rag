# Knowledge RAG 知识库问答平台设计说明

- 日期：2026-10-23
- 状态：设计已确认，待实现
- 目标环境：本地开发 + 阿里云 ECS（Docker Compose）

## 1. 背景与目标

构建一个可部署到阿里云 ECS 的多租户知识库问答平台。用户注册后创建或加入组织，在组织内管理知识库、上传文档、进行基于 RAG 的问答，并支持团队成员协作与知识库级授权。

核心目标：

1. 完成登录、多租户（组织）、团队角色管理。
2. 完成知识库、文档管理、原文件留存与下载。
3. 完成 TXT / Markdown / PDF / DOCX 的异步解析、切分、向量化与检索问答。
4. 聊天与文档处理状态通过 WebSocket 实时推送。
5. 通过 Docker Compose 实际部署到阿里云 ECS，只占用新端口，不影响现有 80 端口服务。
6. 对跨组织越权、知识库级越权和文件下载越权有明确防护与测试。

## 2. 范围

### 2.1 本期包含

- 开放注册（可选邀请链接加入组织）、登录、登出、修改密码
- 组织（租户）创建、切换、改名
- 组织成员角色：Owner / Admin / Member
- 邀请链接：创建、查看、撤销、接受
- 知识库 CRUD、组织公开 / 指定成员两种访问模式
- 知识库成员三级权限：viewer / editor / manager
- TXT、MD、PDF、DOCX 原文件存储、下载与异步入库
- PostgreSQL + pgvector 向量检索
- SiliconFlow embedding 与 DeepSeek 流式对话
- WebSocket：聊天流式输出、取消生成、文档状态推送
- React + TypeScript 前端
- Docker 镜像、Compose、Nginx、部署与回滚文档
- 本地开发、自动化测试、真实 ECS 部署与验收

### 2.2 本期不包含

- 邮件发送、邮箱验证、密码找回
- OAuth / SSO / 手机号登录
- 跨组织共享知识库
- 知识库邀请链接（只支持从组织成员中授权）
- OCR、扫描件识别、旧版 `.doc`
- 对象存储（OSS）、CDN
- 组织删除、所有权转移、成员主动退出
- 计费、审计日志、数据导出
- 多 API 实例与 WebSocket 横向扩展
- HTTPS 证书（先使用公网 IP + HTTP，后续再升级）
- 自动化备份、监控告警、CI/CD

## 3. 架构总览

```text
Browser (React SPA)
   │  HTTP /api/*        WebSocket /socket.io
   ▼
Nginx (web container)
   ├── 静态资源 SPA
   ├── /api      → api:3300
   └── /socket.io→ api:3300 (upgrade)
                         │
                 ┌───────┴────────┐
                 │ NestJS API     │
                 │ - Auth/Session │
                 │ - Org/KB ACL   │
                 │ - Chat/RAG     │
                 │ - WS Gateway   │
                 └───┬────────┬───┘
                     │        │
        pg-boss 入队  │        │ SQL / LISTEN
                     ▼        ▼
              ┌──────────┐  ┌──────────────────────┐
              │ NestJS   │  │ PostgreSQL 15        │
              │ Worker   │  │ pgvector 0.8.6       │
              │ 解析/切分 │  │ knowledge_rag 库      │
              │ /embedding│ │ pgboss schema         │
              └──────────┘  └──────────────────────┘
                     │
                     └── 原文件：Docker 数据卷 /data/uploads
```

关键决策：

- 队列使用 **pg-boss**，复用现有 PostgreSQL，不引入 Redis。
- API 与 Worker 是同一代码库的两个独立进程/容器，职责分离。
- Worker 完成状态更新后使用 PostgreSQL `LISTEN/NOTIFY` 通知 API，API 再通过 Socket.IO 广播。
- 多租户采用共享库、共享表 + `org_id` 隔离，权限在服务层强制校验。
- 原文件存储在 ECS 本地 Docker 数据卷，通过鉴权接口下载。
- 认证使用服务端 Session + httpOnly Cookie，不使用 localStorage 保存 JWT。

## 4. 技术栈

| 层 | 选型 |
|---|---|
| 前端 | React 19、TypeScript、Vite、Tailwind CSS v4、React Router、TanStack Query、socket.io-client、react-markdown、lucide-react |
| 后端 | NestJS 11、TypeScript、pg、pg-boss 11.1.2（CommonJS）、Socket.IO、class-validator、bcryptjs、cookie-parser、@nestjs/throttler |
| 解析 | pdf-parse（PDF）、mammoth（DOCX）、iconv-lite（TXT/MD 编码回退） |
| 数据库 | PostgreSQL 15.18 + pgvector 0.8.6（复用现有实例） |
| Embedding | SiliconFlow `BAAI/bge-m3`，1024 维 |
| Chat | SiliconFlow `deepseek-ai/DeepSeek-V4.1-Flash` |
| 部署 | Docker、Docker Compose、Nginx |
| 测试 | Jest + Supertest（后端）、Vitest（前端工具函数）、浏览器手工验收 |

## 5. 仓库结构

```text
knowledge-rag/
├─ apps/
│  ├─ api/
│  │  ├─ src/
│  │  │  ├─ main.ts
│  │  │  ├─ worker.ts
│  │  │  ├─ app.module.ts
│  │  │  ├─ worker.module.ts
│  │  │  ├─ config/
│  │  │  ├─ database/        # Pool、迁移、迁移脚本
│  │  │  ├─ auth/             # 注册、登录、会话、密码
│  │  │  ├─ organizations/    # 组织、成员、邀请
│  │  │  ├─ knowledge-bases/  # KB CRUD、KB 成员授权
│  │  │  ├─ documents/        # 上传、下载、删除、重试
│  │  │  ├─ ingestion/        # 解析、切分、embedding、队列消费
│  │  │  ├─ llm/              # SiliconFlow 封装
│  │  │  ├─ chat/             # 检索、提示词、会话、WebSocket 聊天
│  │  │  ├─ realtime/         # Socket.IO Gateway、PG LISTEN/NOTIFY
│  │  │  ├─ storage/          # 本地文件存储
│  │  │  └─ common/           # 守卫、装饰器、过滤器、DTO 工具
│  │  ├─ migrations/
│  │  ├─ test/
│  │  └─ Dockerfile
│  └─ web/
│     ├─ src/
│     │  ├─ app/              # 路由、Providers、AppShell
│     │  ├─ features/auth/
│     │  ├─ features/organizations/
│     │  ├─ features/knowledge-bases/
│     │  ├─ features/documents/
│     │  ├─ features/chat/
│     │  ├─ components/ui/
│     │  ├─ lib/              # api、socket、query、format
│     │  └─ styles/
│     ├─ Dockerfile
│     └─ nginx.conf
├─ deploy/
│  ├─ docker-compose.yml
│  ├─ .env.production.example
│  └─ DEPLOY.md
├─ docs/superpowers/specs/
├─ .env                       # 本地开发配置（gitignore）
├─ .gitignore
├─ package.json               # npm workspaces
└─ README.md
```

## 6. 数据模型

所有主键为 `uuid`，默认 `gen_random_uuid()`；时间使用 `timestamptz`。

### 6.1 users

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | |
| email | text | 原样保存，唯一索引 `lower(email)` |
| password_hash | text | bcrypt，cost 12 |
| name | text | 展示名，1–50 字符 |
| created_at / updated_at | timestamptz | |

### 6.2 sessions

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | |
| user_id | uuid FK users CASCADE | |
| token_hash | text UNIQUE | SHA-256(`base64url` 随机令牌) |
| expires_at | timestamptz | 登录后 7 天，绝对过期 |
| created_at / last_used_at | timestamptz | |

### 6.3 organizations

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | |
| name | text | 1–60 字符 |
| created_by | uuid FK users SET NULL | |
| created_at / updated_at | timestamptz | |

### 6.4 memberships

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | |
| org_id | uuid FK organizations CASCADE | |
| user_id | uuid FK users CASCADE | |
| role | text | `owner` / `admin` / `member` |
| created_at / updated_at | timestamptz | |

唯一约束 `(org_id, user_id)`；索引 `user_id`。每个组织在本期有且仅有一个 owner，不支持所有权转移。

### 6.5 invites

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | |
| org_id | uuid FK CASCADE | |
| token_hash | text UNIQUE | |
| role | text | `member` / `admin` |
| created_by | uuid FK users SET NULL | |
| expires_at | timestamptz | 7 天 |
| accepted_at / accepted_by | timestamptz / uuid | 一次性 |
| created_at | timestamptz | |

### 6.6 knowledge_bases

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | |
| org_id | uuid FK organizations CASCADE | |
| name | text | 1–60 字符 |
| description | text | 0–500 字符 |
| access_mode | text | `org`（组织公开）/ `restricted`（指定成员） |
| created_by | uuid FK users SET NULL | |
| created_at / updated_at | timestamptz | |

### 6.7 knowledge_base_members

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | |
| kb_id | uuid FK knowledge_bases CASCADE | |
| user_id | uuid FK users CASCADE | |
| permission | text | `viewer` / `editor` / `manager` |
| granted_by | uuid FK users SET NULL | |
| created_at | timestamptz | |

唯一约束 `(kb_id, user_id)`；索引 `user_id`。创建者和组织 Owner/Admin 不写入本表，按规则隐式拥有 manager。

### 6.8 documents

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | |
| org_id | uuid FK CASCADE | |
| kb_id | uuid FK knowledge_bases CASCADE | |
| uploaded_by | uuid FK users SET NULL | |
| filename | text | 原始文件名 |
| mime_type | text | 上传声明 MIME |
| size_bytes | bigint | |
| storage_key | text | 相对 UPLOAD_DIR 的路径 |
| status | text | `queued` / `processing` / `ready` / `failed` |
| error | text NULL | 最近一次失败原因，截断 500 字符 |
| chunk_count | integer | 默认 0 |
| created_at / updated_at | timestamptz | |

索引 `(kb_id, status)`、`(org_id)`。

### 6.9 chunks

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | |
| org_id | uuid FK CASCADE | |
| kb_id | uuid FK CASCADE | |
| document_id | uuid FK documents CASCADE | |
| chunk_index | integer | 从 0 开始 |
| content | text | 约 800 字符 |
| embedding | vector(1024) | NOT NULL |
| created_at | timestamptz | |

索引：

- HNSW：`USING hnsw (embedding vector_cosine_ops)`
- BTree：`(org_id, kb_id)`
- BTree：`(document_id)`

### 6.10 conversations

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | |
| org_id | uuid FK CASCADE | |
| kb_id | uuid FK CASCADE | |
| user_id | uuid FK users CASCADE | |
| title | text | 首个问题截断 30 字符 |
| created_at / updated_at | timestamptz | |

索引 `(user_id, kb_id, updated_at DESC)`。会话仅创建者可见。

### 6.11 messages

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | |
| conversation_id | uuid FK conversations CASCADE | |
| role | text | `user` / `assistant` |
| content | text | |
| sources | jsonb NULL | 仅 assistant，检索来源数组 |
| interrupted | boolean | 默认 false，客户端取消或断线时为 true |
| created_at | timestamptz | |

索引 `(conversation_id, created_at)`。

### 6.12 迁移

- SQL 迁移文件按编号执行，`schema_migrations` 记录已应用版本。
- `migrate` 命令/容器先连接 `postgres` 管理库创建目标业务库（若不存在），再连接目标库执行 `CREATE EXTENSION IF NOT EXISTS vector` 与建表迁移。
- 迁移可重复执行且使用 advisory lock 防止并发。
- 数据库隔离：本地开发 `knowledge_rag_dev`，自动化测试 `knowledge_rag_test`，生产 `knowledge_rag`；三者不得混用。
- 测试库 `knowledge_rag_test` 由测试初始化流程单独创建与迁移。

## 7. 认证与会话

### 7.1 注册与登录

- 开放注册。无邀请时：姓名、邮箱、密码、组织名；事务内创建用户、组织、owner membership、session。
- 带邀请 token 注册：姓名、邮箱、密码；事务内创建用户、加入邀请对应组织为邀请角色、标记邀请已使用、创建 session。
- 登录：邮箱不区分大小写；密码使用 bcrypt 校验；失败统一返回“邮箱或密码错误”。
- 密码：8–72 字符；bcryptjs cost 12。
- 登出：删除当前 session。
- 修改密码：需当前密码；成功后删除该用户其他 session。
- 本期无邮箱验证与密码找回。

### 7.2 Session Cookie

- Cookie 名：`kr_session`
- 值：32 字节随机数 base64url；数据库仅保存 SHA-256 哈希
- 属性：`HttpOnly; Path=/; SameSite=Lax; Max-Age=604800`，`Secure` 由 `COOKIE_SECURE` 控制
- 生产 HTTP 阶段 `COOKIE_SECURE=false`；后续切 HTTPS 时改为 true
- 每次请求校验：session 存在、未过期、用户存在；更新 `last_used_at`

### 7.3 CSRF 与限流

- 所有非 GET/HEAD HTTP 请求若带 `Origin` 头，必须与 `APP_ORIGIN` 完全一致；否则 403。
- WebSocket 握手同样校验 `Origin`。
- `SameSite=Lax` + Origin 校验作为本期 CSRF 防护。
- 限流：登录 5 次/分钟/IP，注册 10 次/小时/IP，邀请查询 30 次/分钟/IP；使用 `@nestjs/throttler`。

### 7.4 权限校验入口

- `SessionGuard`：解析 Cookie，注入当前用户。
- `OrgMemberGuard`：校验 URL 中的 `orgId` 与成员关系，注入组织角色。
- `KbPermissionGuard`：校验 `kbId` 与所需 KB 权限，注入有效权限。
- 所有数据查询必须同时带 `org_id` 条件；服务层再做资源归属校验，禁止仅依赖前端。

## 8. 多租户与权限

### 8.1 组织角色

| 操作 | Owner | Admin | Member |
|---|---|---|---|
| 修改组织名 | 是 | 否 | 否 |
| 查看成员 | 是 | 是 | 是 |
| 创建邀请（member） | 是 | 是 | 否 |
| 创建邀请（admin） | 是 | 否 | 否 |
| 修改成员角色 | 是 | 否 | 否 |
| 移除成员 | 是（不能移除 owner） | 是（仅 member） | 否 |
| 创建知识库 | 是 | 是 | 是 |
| 所有知识库隐式 manager | 是 | 是 | 否 |

- Owner 唯一，注册创建组织者自动成为 Owner。
- Admin 可以被 Owner 提升或降级；Owner 不可被移除。
- 移除成员时：删除其在该组织的 `memberships`、`knowledge_base_members`、`conversations` 及消息（级联）；保留其上传的文档与审计价值。
- 组织删除与主动退出不在本期范围。

### 8.2 知识库访问模式与三级权限

访问模式：

- `org`：组织内所有成员默认 viewer。
- `restricted`：仅创建者、显式授权成员、组织 Owner/Admin 可访问。

显式权限：

- `viewer`：查看知识库、问答、下载文档、查看文档列表。
- `editor`：viewer 权限 + 上传、删除文档、重试失败任务。
- `manager`：editor 权限 + 修改知识库名称/描述/访问模式、管理知识库成员。

有效权限计算（取最高）：

1. 组织 Owner/Admin → `manager`
2. 知识库创建者 → `manager`（不可被移除）
3. `knowledge_base_members` 显式授权 → 对应等级
4. `access_mode = org` 且为组织成员 → `viewer`
5. 否则无权限

其他规则：

- 删除知识库：创建者或组织 Owner/Admin。
- 知识库成员只能从当前组织成员中选择，不支持跨组织。
- 知识库访问模式从 `org` 改为 `restricted` 时，未显式授权成员立即失去访问；前端需二次确认并提示。
- 用户失去知识库访问权后，其历史会话保留在库中但不可再访问；恢复权限后恢复可见。知识库删除时会话级联删除。
- 组织公开知识库中，普通成员的默认权限是 viewer，可被单独提升为 editor/manager。

## 9. REST API

统一前缀 `/api`。错误响应格式：`{ "statusCode": number, "message": string | string[], "error": string }`。

### 9.1 认证

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/auth/register` | `{name,email,password,orgName?}` 或 `{name,email,password,inviteToken}` |
| POST | `/auth/login` | `{email,password}` |
| POST | `/auth/logout` | 删除当前 session |
| GET | `/auth/me` | 当前用户 + 所属组织及角色 |
| POST | `/auth/password` | `{currentPassword,newPassword}` |

### 9.2 邀请

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/invites/:token` | 公开，返回组织名、邀请角色、是否有效 |
| POST | `/invites/:token/accept` | 登录用户接受邀请 |

### 9.3 组织

| 方法 | 路径 | 权限 |
|---|---|---|
| POST | `/orgs` | 任意登录用户，创建新组织并成为 Owner |
| PATCH | `/orgs/:orgId` | Owner |
| GET | `/orgs/:orgId/members` | 组织成员 |
| PATCH | `/orgs/:orgId/members/:userId` | Owner，`{role: admin|member}` |
| DELETE | `/orgs/:orgId/members/:userId` | Owner/Admin，受角色限制 |
| GET / POST | `/orgs/:orgId/invites` | Owner/Admin |
| DELETE | `/orgs/:orgId/invites/:inviteId` | Owner/Admin |

### 9.4 知识库

| 方法 | 路径 | 权限 |
|---|---|---|
| GET / POST | `/orgs/:orgId/knowledge-bases` | 组织成员 |
| GET | `/orgs/:orgId/knowledge-bases/:kbId` | viewer+ |
| PATCH | `/orgs/:orgId/knowledge-bases/:kbId` | manager |
| DELETE | `/orgs/:orgId/knowledge-bases/:kbId` | 创建者或 Owner/Admin |
| GET | `/orgs/:orgId/knowledge-bases/:kbId/members` | manager |
| POST | `/orgs/:orgId/knowledge-bases/:kbId/members` | manager，`{userId,permission}` |
| PATCH | `/orgs/:orgId/knowledge-bases/:kbId/members/:userId` | manager，`{permission}` |
| DELETE | `/orgs/:orgId/knowledge-bases/:kbId/members/:userId` | manager |

列表响应仅返回当前用户可访问的知识库，并带有效权限、文档数、成员数。

### 9.5 文档

| 方法 | 路径 | 权限 |
|---|---|---|
| GET | `/orgs/:orgId/knowledge-bases/:kbId/documents` | viewer+ |
| POST | `/orgs/:orgId/knowledge-bases/:kbId/documents` | editor+，multipart 字段 `file` |
| POST | `/orgs/:orgId/documents/:documentId/retry` | editor+ |
| GET | `/orgs/:orgId/documents/:documentId/download` | viewer+，流式下载原文件 |
| DELETE | `/orgs/:orgId/documents/:documentId` | editor+ |

上传成功返回 201 与文档对象（`status=queued`），随后入队。删除文档同时删除 chunks、原文件与进行中的任务（worker 会检测文档是否仍存在）。

### 9.6 会话

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/orgs/:orgId/knowledge-bases/:kbId/conversations` | 当前用户在该 KB 的会话 |
| POST | `/orgs/:orgId/knowledge-bases/:kbId/conversations` | 创建空会话 |
| GET | `/orgs/:orgId/conversations/:conversationId/messages` | 当前用户自己的会话 |
| DELETE | `/orgs/:orgId/conversations/:conversationId` | 当前用户自己的会话 |

聊天本身只通过 WebSocket 发送与接收。

### 9.7 健康检查

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 返回 `{status,db,queue}`；失败时 503 |

## 10. WebSocket 协议

- 使用 Socket.IO，默认命名空间，Engine.IO 路径 `/socket.io`
- 握手复用 `kr_session` Cookie；校验 Origin、Session 和用户
- 客户端连接后自动加入 `user:{userId}` 房间
- 访问知识库页面时发送 `kb:join {orgId, kbId}`；服务端校验 viewer 权限后加入 `kb:{kbId}`；离开时 `kb:leave {kbId}`
- 房间隔离：未授权无法加入；服务端所有广播均基于已校验房间
- 单连接同时只允许一个进行中的聊天请求
- 聊天限流：每用户 10 次/分钟

### 10.1 客户端 → 服务端

| 事件 | 载荷 | 说明 |
|---|---|---|
| `kb:join` | `{orgId,kbId}` | 加入知识库房间，ack `{ok,permission}` |
| `kb:leave` | `{kbId}` | 离开房间 |
| `chat:send` | `{orgId,kbId,conversationId?,question,requestId}` | 发起问答；问题 1–2000 字符 |
| `chat:cancel` | `{requestId}` | 取消当前生成 |

### 10.2 服务端 → 客户端

| 事件 | 载荷 | 说明 |
|---|---|---|
| `chat:meta` | `{requestId,conversationId,userMessageId,sources}` | 会话与检索来源 |
| `chat:delta` | `{requestId,text}` | 增量文本 |
| `chat:done` | `{requestId,assistantMessageId,conversationId,cancelled}` | 完成 |
| `chat:error` | `{requestId,message}` | 失败 |
| `document:status` | `{documentId,kbId,status,chunkCount,error}` | 文档状态变更 |
| `kb:access-revoked` | `{kbId}` | 当前用户的知识库权限被移除，前端离开相关页面 |

### 10.3 文档状态通知链路

1. Worker 更新文档状态并提交事务。
2. Worker 执行 `pg_notify('kr_document_status', payload)`；内部载荷为 `{documentId,orgId,kbId,uploadedBy,status,chunkCount,error}`。
3. API 启动时建立独立 PG 连接执行 `LISTEN kr_document_status`，断线自动重连。
4. API 将事件广播到 `kb:{kbId}` 和 `user:{uploadedBy}` 的并集（不向前端暴露 `uploadedBy`）。
5. 前端收到后刷新文档列表与状态徽标；Socket 断开时退化为 5 秒轮询，重连后停止轮询并重新拉取。

### 10.4 会话与授权失效

- 每次 `kb:join` 与 `chat:send` 都重新校验 Session 有效期、组织成员关系与 KB 权限；Session 过期立即断开连接。
- KB 成员被移除、访问模式改为 restricted、组织成员被移除时，API 主动让该用户 Socket 离开 `kb:{kbId}` 房间，并发送 `kb:access-revoked`。
- 前端收到 `kb:access-revoked` 后回到组织首页并刷新知识库列表。
- Socket 最长连接时间为 24 小时，之后强制重新握手。

### 10.5 聊天取消与断线

- `chat:cancel` 中止上游 SiliconFlow 流；已生成内容若非空则保存为 assistant 消息，`interrupted=true`。
- Socket 断开时同样中止该连接所有进行中的上游请求并按上述规则保存。
- 若生成失败且没有内容，不创建 assistant 消息，返回 `chat:error`；用户消息保留。

## 11. 文档解析、切分与 RAG

### 11.1 允许类型

| 扩展名 | MIME | 解析 |
|---|---|---|
| `.txt` | text/plain | 文本解码 |
| `.md` | text/markdown, text/plain | 文本解码 |
| `.pdf` | application/pdf | pdf-parse |
| `.docx` | application/vnd.openxmlformats-officedocument.wordprocessingml.document | mammoth |

- 单文件上限 20MB；Nginx 限制 25MB。
- 校验扩展名、MIME 与魔数：PDF 以 `%PDF-` 开头；DOCX 为 ZIP 容器（`PK\x03\x04`）。
- TXT/MD 优先 UTF-8 严格解码，失败时使用 GB18030 回退；去除 BOM。
- PDF 最多解析 200 页，解析超时 60 秒；无有效文本时失败并提示可能为扫描件。
- 旧版 `.doc`、图片、扫描 PDF 不支持。

### 11.2 文本规范化与切分

- 统一换行、去除 NUL 字符、合并超过 3 个连续空行、去除首尾空白。
- 目标块大小 800 字符，重叠 120 字符。
- 优先在段落、换行、中文/英文句末标点处切分；不足一块的短文本作为单块。
- 空文本不产生 chunk；全部为空视为失败。
- 切分函数纯函数化，便于单元测试。

### 11.3 Embedding

- 模型 `BAAI/bge-m3`，1024 维。
- 每批 16 条，串行提交；429/5xx 指数退避重试 3 次；请求超时 60 秒。
- 同一文档重试时先删除旧 chunks，再在事务内插入新 chunks 并更新文档状态。
- 入库失败不会留下半成品数据。

### 11.4 检索

```sql
SELECT c.id, c.document_id, c.chunk_index, c.content,
       d.filename,
       1 - (c.embedding <=> $1::vector) AS score
FROM chunks c
JOIN documents d ON d.id = c.document_id
WHERE c.org_id = $2
  AND c.kb_id = $3
  AND d.status = 'ready'
ORDER BY c.embedding <=> $1::vector
LIMIT $4;
```

- 默认 Top 6，最小相似度 0.2，参数可配置。
- 不满足阈值视为无结果。
- 无结果时不调用大模型，直接返回固定提示并保存为 assistant 消息。

### 11.5 提示词

系统提示词（中文）：

```text
你是知识库问答助手。只能依据提供的资料回答，不得编造资料中没有的信息。
回答时在相关句子后标注来源编号，例如 [1]、[2]。
如果资料不足以回答，请明确说明“知识库中没有找到足够的信息”，并给出可能的下一步建议。
使用与用户问题相同的语言回答，保持简洁、准确。
```

上下文格式：

```text
[1] 文件：xxx.md（片段 3）
<chunk 内容>

[2] 文件：yyy.pdf（片段 0）
<chunk 内容>
```

- 附带最近 6 条会话消息作为对话历史。
- 模型参数：`temperature=0.2`，`max_tokens=1500`，流式。
- 上游使用 OpenAI 兼容接口，解析 `data:` 行与 `[DONE]`；遇到异常发出 `chat:error`。

### 11.6 来源结构

```json
[
  {
    "index": 1,
    "documentId": "uuid",
    "filename": "handbook.pdf",
    "chunkId": "uuid",
    "chunkIndex": 3,
    "score": 0.82,
    "content": "片段原文"
  }
]
```

来源保存到 assistant 消息的 `sources` 字段，前端展示为编号卡片并可展开原文。

## 12. 队列与 Worker

- 队列：pg-boss，schema `pgboss`，与业务表同库。
- 任务名：`document.ingest`，载荷 `{documentId,orgId,kbId,uploadedBy}`。
- API 仅负责入队；Worker 独立进程消费。
- 并发通过 `WORKER_CONCURRENCY` 配置：按配置数量注册多个 pg-boss worker；目标服务器为 2 核 / 1.8GB 内存，默认 1。单任务最长 30 分钟；重试 2 次（共 3 次尝试），指数退避。
- Worker 每次开始处理时将文档置为 `processing` 并清空 error；成功置为 `ready` 并写入 chunk_count；失败置为 `failed`、写入错误并抛出以触发队列重试。全部重试耗尽后最终状态为 `failed`。
- 手动重试接口：重新置为 `queued` 并入队新任务；使用 `documentId + 时间戳` 作为任务唯一键，避免覆盖历史任务。
- Worker 在写入前检查文档仍存在，避免删除后重建数据。
- 优雅退出：停止拉取新任务，等待进行中的任务完成或超时。

## 13. 文件存储

- 根目录：`UPLOAD_DIR`，本地开发为 `apps/api/storage`，生产挂载 `/data/uploads`。
- 路径：`orgs/{orgId}/knowledge-bases/{kbId}/documents/{documentId}/{sanitizedFilename}`。
- `storage_key` 保存相对路径；读取时 `resolve` 后必须仍位于 `UPLOAD_DIR` 内，防止路径穿越。
- 上传先落盘，创建文档记录后入队；任何一步失败则清理已写入文件。
- 下载：先做 viewer 权限校验，再以 `Content-Disposition: attachment` 流式返回，支持中文文件名。
- 删除文档：删除数据库记录与 chunks（级联），再删除文件；文件删除失败仅记录日志，不阻塞接口。
- 删除知识库：递归删除该 KB 目录；数据库级联删除关联记录。
- 不做原文件内容去重；重复上传产生新文档。

## 14. 前端设计

### 14.1 路由

| 路径 | 页面 |
|---|---|
| `/login` | 登录 |
| `/register` | 注册（支持 `?invite=token`） |
| `/join/:token` | 邀请落地页：未登录引导注册/登录，已登录直接接受 |
| `/orgs/:orgId` | 组织首页 / 知识库列表 |
| `/orgs/:orgId/kbs/:kbId/chat` | 对话 |
| `/orgs/:orgId/kbs/:kbId/documents` | 文档 |
| `/orgs/:orgId/kbs/:kbId/members` | 知识库成员授权 |
| `/orgs/:orgId/members` | 组织成员与邀请 |
| `/orgs/:orgId/settings` | 组织设置（改名） |

未登录访问受保护路由跳转 `/login?next=...`；无权限显示 403 页面。

### 14.2 布局与视觉

- 左侧深色侧栏（石板灰/近黑）+ 浅暖灰主背景 + 靛蓝强调色。
- 侧栏：Logo、组织切换器、知识库列表、创建知识库、用户菜单。
- 知识库内二级导航：对话 / 文档 / 成员；对话页额外有会话侧栏。
- 卡片使用圆角、细边框和轻阴影；不使用大面积渐变；保持信息密度与留白平衡。
- 图标使用 lucide-react；中文界面；桌面优先，移动端侧栏与会话栏改为抽屉。
- 统一的 Button / Input / Select / Dialog / Badge / Tooltip / Toast / EmptyState 基础组件。

### 14.3 关键交互

- 注册/登录表单错误内联显示；提交中禁用。
- 组织切换后保持当前知识库路径对应的新组织首页，不跨组织复用 ID。
- 新建知识库：名称、描述、访问模式（组织公开 / 指定成员）；创建后进入文档页。
- 文档页：拖拽/多选上传，逐个上传；状态徽标（排队中/处理中/就绪/失败）；失败显示原因与重试；支持下载原文件与删除。
- 知识库成员页：展示继承的 Owner/Admin、显式成员；添加组织成员并选择 viewer/editor/manager；可修改/移除；切换访问模式时二次确认。
- 组织成员页：成员列表与角色、邀请链接生成（选择 member/admin，Owner 才可选 admin）、复制链接、撤销邀请。
- 对话页：会话列表、新对话、Markdown 渲染（禁用原始 HTML）、流式光标、停止生成、引用来源卡片、自动滚动（仅在接近底部时）、Enter 发送 / Shift+Enter 换行。
- WebSocket 状态：连接中/已断开提示；断线自动重连并刷新当前文档与会话状态。
- 所有破坏性操作（删除知识库、删除文档、移除成员、撤销邀请）使用确认对话框。

### 14.4 状态管理

- TanStack Query 管理服务端状态；query key 按 org/kb 维度隔离。
- AuthContext 缓存 `/auth/me`，401 时清空并跳转登录。
- SocketProvider 负责连接、重连、加入/离开 KB 房间、事件分发。
- 聊天流使用本地状态累积；完成后刷新会话列表与会话消息。

## 15. 错误处理与安全

### 15.1 错误处理

- 全局 ValidationPipe（whitelist、transform）。
- 统一异常过滤器；记录 5xx 日志，不向前端泄露堆栈。
- 上传类型/大小/魔数不合法返回 400；解析与向量化失败记录在文档 error 字段。
- WebSocket 所有失败事件带 `requestId`；未知异常统一为“生成失败，请稍后重试”。
- 前端请求失败使用 Toast + 行内提示；WebSocket 中断保留已生成内容。

### 15.2 安全清单

- 密码 bcrypt cost 12；会话令牌只存哈希；Cookie httpOnly + SameSite=Lax。
- Origin 校验覆盖所有写操作与 WebSocket 握手。
- 所有资源查询强制 `org_id` 与权限过滤；写操作二次校验归属。
- 上传：扩展名 + MIME + 魔数 + 大小；存储路径由服务端生成；下载前鉴权。
- Nginx 仅暴露 Web 端口；API、Worker、数据库不对公网开放。
- Redis 不引入；pg-boss 与业务共用数据库连接池配置。
- Markdown 不启用 raw HTML，防止 XSS。
- 日志不打印密码、Cookie、API Key、数据库连接串、完整文档内容。
- `.env` 与 `.env.production` 加入 `.gitignore`，不进入镜像与仓库。
- 本期 HTTP 明文传输，仅作为临时上线方式；后续绑定域名 + HTTPS 后启用 Secure Cookie。

### 15.3 已知风险

- 开放注册且无邮箱验证，可能被滥用；通过注册限流，并提供关闭开放注册的配置项（见环境变量）。
- 现有 PostgreSQL 使用超级用户凭据且公网可达；本期沿用，部署文档给出收敛建议。
- 单 API 实例的 WebSocket 不支持横向扩容；后续多实例需 Socket.IO adapter。
- 本地磁盘存储依赖单机；迁移到 OSS 需要新增存储适配层（本期不做）。
- 目标 ECS 仅 1.8GB 内存且已有多个服务运行，构建与运行阶段均受内存约束；API/Worker 需限制 Node 堆大小，Worker 默认单并发，构建必须串行执行。
- 现有 `pgvector` 容器 `restart=no`，服务器重启后数据库不会自动启动；建议在征得确认后将其改为 `unless-stopped`，本期部署不擅自修改。

## 16. 环境变量

| 变量 | 说明 | 默认/示例 |
|---|---|---|
| `PORT` | API 端口 | `3300` |
| `APP_ORIGIN` | 前端访问源，用于 Origin 校验 | 本地 `http://localhost:5173`；生产 `http://<SERVER_IP>:8088` |
| `COOKIE_SECURE` | Cookie Secure 标志 | 本地/HTTP `false` |
| `REGISTRATION_ENABLED` | 是否允许无邀请注册 | `true` |
| `API_KEY` | SiliconFlow API Key | 继承现有 `.env` |
| `BASE_URL` | SiliconFlow API 地址 | `https://api.siliconflow.cn/v1` |
| `MODEL` | 对话模型 | `deepseek-ai/DeepSeek-V4.1-Flash` |
| `EMBEDDING_MODEL` | Embedding 模型 | `BAAI/bge-m3` |
| `EMBEDDING_DIMENSIONS` | 向量维度 | `1024` |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` | PostgreSQL 连接 | 继承现有 `.env` |
| `DB_NAME` | 业务库 | 本地 `knowledge_rag_dev`；生产 `knowledge_rag`；测试 `knowledge_rag_test` |
| `DB_SSL` | 是否启用 SSL | `false` |
| `UPLOAD_DIR` | 原文件根目录 | 本地 `./storage`；生产 `/data/uploads` |
| `MAX_UPLOAD_MB` | 上传上限 | `20` |
| `CHUNK_SIZE` | 切分字符数 | `800` |
| `CHUNK_OVERLAP` | 重叠字符数 | `120` |
| `RETRIEVAL_TOP_K` | 检索条数 | `6` |
| `RETRIEVAL_MIN_SCORE` | 最小相似度 | `0.2` |
| `SESSION_TTL_DAYS` | 会话有效期 | `7` |
| `WORKER_CONCURRENCY` | Worker 并发 | 目标服务器 `1` |
| `APP_PORT` | 生产宿主机端口 | `8088` |

- 本地 `.env` 保留现有配置；将 `DB_NAME` 改为 `knowledge_rag_dev` 并追加 RAG/上传/会话参数；生产使用独立的 `knowledge_rag`。
- 生产使用 `deploy/.env.production`，不提交到版本库。

## 17. 部署设计

### 17.1 目标拓扑

- 阿里云 ECS：<SERVER_IP>（root）
- 现有 80 端口服务保持不变
- 本应用宿主机端口：`APP_PORT`（默认 8088），容器内 Nginx 监听 80
- PostgreSQL 复用现有实例，新建 `knowledge_rag` 库
- Docker Compose 项目名：`knowledge-rag`
- 部署目录：`/opt/knowledge-rag`
- 数据卷：`knowledge-rag_uploads_data`（原文件）
- 无 Redis

### 17.2 服务

| 服务 | 镜像/构建 | 说明 |
|---|---|---|
| `migrate` | api 镜像 | 执行建库与迁移，完成后退出 |
| `api` | api Dockerfile | NestJS HTTP + Socket.IO，内部 3300 |
| `worker` | api 镜像 | 运行 `node dist/worker.js`，消费 pg-boss |
| `web` | web Dockerfile | 构建前端 + Nginx，映射 `${APP_PORT}:80` |

`api` 与 `worker` 挂载同一上传卷；`web` 不挂载文件。`api` 与 `worker` 不映射端口到宿主机。

### 17.3 Nginx

- SPA：`try_files $uri /index.html`
- `/api/`：反代 `http://api:3300`，`client_max_body_size 25m; proxy_read_timeout 300s; proxy_buffering off;`
- `/socket.io/`：WebSocket upgrade，`proxy_read_timeout 600s`
- 基础安全头：`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: strict-origin-when-cross-origin`
- gzip 静态资源

### 17.4 部署流程

1. 使用本机 `<SSH_HOST>` SSH 别名连接服务器（需要先把生成的公钥加入 `/root/.ssh/authorized_keys`）。
2. 只读审计：OS、Docker/Compose 是否存在、磁盘/内存、8088 端口占用、现有 80 服务、PostgreSQL 可达性。
3. 若缺少 Docker，先征求确认再安装；不重启现有服务。
4. 创建 `/opt/knowledge-rag`，上传代码与 `deploy/.env.production`（排除 node_modules、本地 .env、storage）。
5. 在阿里云安全组放行 `APP_PORT`；由用户在控制台完成。
6. `docker compose -p knowledge-rag up -d --build`。
7. 验证 `/api/health`、注册、上传 TXT/PDF/DOCX、WebSocket 流式问答、文件下载。
8. 记录部署结果与回滚步骤。

### 17.5 回滚与备份

- 回滚：`docker compose -p knowledge-rag down`（保留数据卷与数据库）；需要彻底清理时先征得确认再删除卷与 `knowledge_rag` 库。
- 备份：`pg_dump knowledge_rag` + 备份 `knowledge-rag_uploads_data` 卷。
- 应用升级：重新构建并 `up -d`；迁移随 `migrate` 服务执行。

### 17.6 生产安全

- 只开放 `APP_PORT`；不开放 3300、pg-boss 与数据库新增端口。
- 建议后续将 PostgreSQL 访问限制到 ECS 内网/白名单，并改用最小权限数据库账号。
- HTTP 阶段 Cookie 不加密传输；尽快绑定域名并启用 HTTPS 与 `COOKIE_SECURE=true`。

### 17.7 服务器实测基线（2026-10-23）

- 系统：Alibaba Cloud Linux 4.0.3，内核 6.6，2 vCPU，1.8GB 内存，2GB Swap，根分区 40GB（可用约 20GB）。
- Docker 24.0.9，Docker Compose v2.27.0，Docker 服务运行中。
- 现有容器：`xflow-nginx`（80）、`travel-web`（8000）、`xflow-backend`（内部 8080）、`travel-backend`（内部 3300）、`pgvector`（5432）、`my-mysql`（3306）。**已有服务名称与端口必须保持不变。**
- 可用端口：**8088 当前空闲**；80、8000、3306、5432 已占用。
- PostgreSQL：Docker 容器 `pgvector`（`pgvector/pgvector:pg15`），数据绑定挂载 `/data/pgvector`，端口 `0.0.0.0:5432`，restart policy 为 `no`。
- 容器到数据库：已用 `host.docker.internal:5432` 通过 `pg_isready` 验证可达；生产 compose 为 `migrate/api/worker` 增加 `extra_hosts: ["host.docker.internal:host-gateway"]`，并设置 `DB_HOST=host.docker.internal`。认证在首次迁移时验证。
- 资源风险：现有容器占用约 420MB，内存余量约 700MB；构建必须串行（先 API，再 Web），并为 API/Worker 设置 Node 堆上限（API 256MB、Worker 384MB），Worker 单并发。
- 防火墙：firewalld `public` zone 已放行 22/80/3306/8080，Docker 发布端口由其自行管理；8088 仍需在阿里云安全组放行后从公网验证。

## 18. 测试策略

### 18.1 后端单元测试

- 密码哈希与会话令牌生成/校验
- 组织角色与知识库有效权限计算（含管理员穿透、访问模式切换）
- 文本切分：边界、重叠、短文本、空文本
- TXT/MD 编码回退、PDF/DOCX 解析（小型 fixture；扫描 PDF 失败）
- 提示词组装与来源编号
- LLM 流解析（正常、断流、错误）
- 存储路径安全与文件名清洗

### 18.2 后端集成/E2E

使用独立 `knowledge_rag_test` 库，迁移后每例清空业务表；LLM 使用可控 fake 实现，避免测试依赖外部服务。

- 注册建组织、登录、登出、修改密码
- 邀请创建/接受/撤销；重复接受失败
- 跨组织访问返回 403/404
- 组织角色矩阵、KB 三级权限、管理员穿透、受限库不可见
- 上传入队 → 直接调用 worker 处理函数（fake embedding）→ 文档 ready、chunks 写入
- 文档下载鉴权；删除后文件与 chunks 清理
- WebSocket 握手鉴权、房间隔离、聊天事件顺序、取消
- 健康检查

### 18.3 前端测试与验收

- Vitest：流式消息累积/取消、错误状态处理、工具函数
- `tsc --noEmit`、`vite build`
- 浏览器手工验收：注册→建组织→邀请→知识库→上传四种格式→实时状态→流式问答→引用→下载→权限切换→越权检查→断线重连
- 部署后在 ECS 公网地址重复关键路径验收

## 19. 实施阶段

1. **基座**：workspace、配置、数据库迁移、认证、组织/成员/邀请、权限守卫与测试。
2. **知识库与文档**：KB CRUD、KB 成员授权、原文件存储、上传/下载/删除、pg-boss、Worker。
3. **解析与 RAG**：TXT/MD/PDF/DOCX 解析、切分、embedding、检索、LLM 流、会话持久化。
4. **实时层**：Socket.IO 鉴权、聊天事件、取消、LISTEN/NOTIFY 文档状态。
5. **前端**：设计系统、认证、应用壳、知识库/文档/对话/成员页面、实时交互。
6. **部署**：Dockerfile、Compose、Nginx、迁移服务、部署文档。
7. **验收与上线**：自动化测试、浏览器验收、ECS 实际部署、生产验证。

## 20. 验收标准

- 新用户可注册并创建组织；邀请链接可让另一用户加入同一组织。
- 跨组织资源访问全部被拒绝；角色与 KB 三级权限行为符合矩阵。
- Owner/Admin 可访问受限知识库；普通成员未授权时不可见。
- TXT/MD/PDF/DOCX 上传后状态通过 WebSocket 实时变化，最终 ready；失败可重试。
- 聊天流式输出、可取消、引用可展开；文档下载受权限保护。
- 原文件保存在数据卷，删除文档/知识库后关联数据清理正确。
- 自动化测试通过，前端类型检查与构建通过。
- 应用在 ECS 的 `APP_PORT` 可访问，现有 80 端口服务不受影响，健康检查正常。

## 21. 待执行的外部前置条件

1. 公钥已加入服务器，`ssh <SSH_HOST>` 已验证可免密登录（2026-10-23）。
2. 阿里云安全组放行最终选定的 `APP_PORT`（默认 8088），部署后从公网验证。
3. Docker 与 Compose 已安装并运行，无需安装 Docker。
4. 现有 `pgvector` 容器重启策略保持现状；是否改为 `unless-stopped` 由用户另行决定。
