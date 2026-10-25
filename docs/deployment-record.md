# 生产部署记录

- 日期：2026-10-23
- 目标：阿里云 ECS `<SERVER_IP>`（root）
- 公网入口：`http://<SERVER_IP>:8088`
- Compose 项目：`knowledge-rag`
- 部署目录：`/opt/knowledge-rag`

## 1. 运行组件

| 服务 | 镜像 | 状态 | 端口 |
|---|---|---|---|
| `knowledge-rag-web-1` | `knowledge-rag-web:local` | Up | `0.0.0.0:8088->80` |
| `knowledge-rag-api-1` | `knowledge-rag-api:local` | Up (healthy) | 内部 3300 |
| `knowledge-rag-worker-1` | `knowledge-rag-api:local` | Up | 内部 3300（无映射） |
| `knowledge-rag-migrate-1` | `knowledge-rag-api:local` | Exited (0) | — |

- 队列：pg-boss 11.1.2，schema `pgboss`，无 Redis
- 镜像运行时：Node 22.22.3；基础镜像使用服务器已有 `node:22-bookworm-slim`
- Nginx 基础镜像：`docker.m.daocloud.io/library/nginx:alpine`（服务器已有缓存）
- 数据卷：`knowledge-rag_uploads_data` → `/data/uploads`

## 2. 数据库

| 用途 | 数据库 | 说明 |
|---|---|---|
| 生产 | `knowledge_rag` | 已迁移并投入使用；保留真实用户数据，部署测试账号已清理 |
| 本地开发 | `knowledge_rag_dev` | 与生产隔离 |
| 自动化测试 | `knowledge_rag_test` | e2e 专用 |

- 复用现有 `pgvector` 容器（PostgreSQL 15 + pgvector 0.8.6）
- 生产 `knowledge_rag` 由 `migrate` 服务创建并迁移
- `pgvector` 容器重启策略已从 `no` 调整为 `unless-stopped`
- 未修改 `postgres`、`travel_db`

## 3. 模型配置

- Chat：`deepseek-ai/DeepSeek-V4.1-Flash`（SiliconFlow，已用最小调用验证）
- Embedding：`BAAI/bge-m3`，1024 维
- 生产环境模型来自 `deploy/.env.production`，未写入代码或镜像

## 4. 验收结果

- 公网健康检查：`http://<SERVER_IP>:8088/api/health` → `{"status":"ok","db":"ok","queue":"ok"}`
- Nginx 静态站点与 `/api` 代理正常
- Nginx `/socket.io/` WebSocket 代理正常
- 完整生产冒烟通过：
  - 注册账号 → 创建组织与知识库
  - 上传 TXT → worker 消费 → 文档 `ready`，生成 1 个片段
  - WebSocket 加入知识库房间
  - 提问后收到流式回答与引用来源
  - 回答正确识别测试文档中的项目代号 `Nova` 与验证令牌 `ZX-9271`
- 现有服务未受影响：
  - `http://<SERVER_IP>/`（xflow）→ 200
  - `http://<SERVER_IP>:8000/`（travel）→ 200
  - 80 / 8000 / 3306 / 5432 端口与原有容器保持不变
- 部署冒烟与 UI 修复验证完成后：
  - 只清理了我创建的测试账号与测试组织，以及对应测试上传文件
  - 生产环境真实用户数据保留，未执行全局清理
  - 截至本记录，生产存在 1 个真实用户 / 1 个组织 / 1 个知识库 / 1 份文档
- 2026-10-23 反馈修复（第一批）：
  - 登录页右侧改为卡片式布局并增加背景氛围与安全提示
  - 所有 `<dialog>` 显式 `m-auto` 居中
  - 新建知识库弹窗改用 `useId()` 生成唯一表单 ID，修复 `invalid form control ... not focusable`
  - Web 镜像已重建并验证：创建知识库成功、浏览器控制台无错误
- 2026-10-23 反馈修复（第三批）：
  - 文档表格改为固定列宽（文件 1fr / 状态 110 / 片段 90 / 时间 160 / 操作 100），表头与行使用同一套列模板，上传时间不换行，彻底对齐
  - 新增受 viewer 权限保护的 `GET /api/orgs/:orgId/documents/:documentId/chunks`，点击文件名可展开该文档的完整分段列表（片段编号 + 原文）
  - 登录页左侧重做为高端视觉：深色极光渐变背景、渐变主标题、玻璃拟态特性卡与指标块、发光轨道知识图谱、LIVE 检索演示卡片、底部信任行；`PRIVATE DEPLOYMENT` 状态徽标
  - Web 镜像已重建，健康检查正常，真实用户数据未受影响
- 2026-10-23 反馈修复（第四批）：
  - 知识库「成员」页修复：组织仅剩创建者一人时「添加成员」按钮被禁用（无候选成员）——按钮改为始终可点击，弹窗内无候选时给出说明与组织邀请链接入口
  - 「添加成员」弹窗支持两条路径：选择组织成员授权（查看/编辑/管理），或生成一次性组织邀请链接（7 天有效）并复制分享；候选成员过滤逻辑抽为纯函数并新增 5 个单测；打开弹窗时自动刷新组织成员列表，避免邀请后候选列表过期
  - 成员列表空态文案随访问模式区分（指定成员 / 组织公开）
  - 仅重建 Web 镜像，API/Worker 未动
- 2026-10-23 功能扩展（第五批）：「添加成员」支持组织外的人
  - 迁移 `002_kb_invites.sql`：`invites` 新增可空 `kb_id`（级联删除）与 `kb_permission` 列，纯增量
  - `POST /orgs/:orgId/knowledge-bases/:kbId/members` 支持 `userId` 或 `email` 二选一；按邮箱添加时：已注册且在本组织 → 直接授权；已注册但不在组织 → 以普通成员身份拉入组织并授权；未注册 → 生成 KB 作用域一次性邀请链接（7 天），注册后自动加入组织并获得授权（注册与登录后接受两条路径均在同一事务写入 kb 授权）
  - 前端弹窗新增「选择组织成员 / 按邮箱添加」两种方式，邀请成功后展示复制链接界面并注明将授予的权限
  - 权限边界：仍由知识库 manager 权限（创建者/管理者/组织 owner/admin）控制，KB 管理者即可邀请组织外的人（不再要求组织 owner/admin）
  - 测试：新增 2 个 e2e（外部已注册用户、未注册邮箱邀请后自动授权），后端 24 e2e + 23 单测、前端 9 测试全绿；本地浏览器完整验证两条路径

- 2026-10-23 RAG 链路改造（第六批）：RAG 链路改用 LangChain
  - **范围与提交**：分支 `sdd/langchain-migration`，实现提交 `ecbdbd3..ca405a0`（B1–B8，含各轮评审修正）；测试注释提交 `4b56d2e..5f62df0`（C1）。迁移前基线快照是 `013b9cc`，但它后面还跟了 Phase A 注释与 BUG-1 `c4d5ea4`、BUG-2 `a45e432`，所以本轮的**回滚基线是 `a45e432`**（理由见下方「回滚方式」）。设计与「实现偏差」记录见 `docs/superpowers/specs/2026-10-23-langchain-migration-design.md`
  - **改了什么**：解析改用 `Document` + `PDFLoader` / `DocxLoader`（TXT/MD 保留自研 GB18030 回退解码后再包成 `Document`）、切分改用 `RecursiveCharacterTextSplitter` + 显式中文分隔符、嵌入改用 `OpenAIEmbeddings`、对话改用 `ChatOpenAI.streamEvents` + `ChatPromptTemplate`、检索新增自定义 `KbRetriever extends BaseRetriever`；**向量存储仍是自研 pgvector SQL**（`RetrievalService` 的隔离列、`status='ready'` JOIN、`1 - 余弦距离` 相似度分数与阈值、HNSW 索引全部不变；阈值比较与引用编号本身在 JS 侧，见 `docs/operations.md` §11.5）。删掉手写 LLM/SSE 与旧 parser 层：`llm.service.ts`、`sse-parser.ts`、`pdf.parser.ts`、`docx.parser.ts`、`prompt.service.ts`
  - **依赖版本**（实测；本仓库是 npm workspace，`@langchain/core` / `openai` / `textsplitters` 与 `pdf-parse`、`mammoth` 都提升到**工作区根** `node_modules`，四个包里只有 `@langchain/community` 落在 `apps/api/node_modules`）：`@langchain/core@1.3.0`、`@langchain/openai@1.7.0`、`@langchain/community@1.1.29`、`@langchain/textsplitters@1.0.2`；`pdf-parse@2.4.5`、`mammoth@1.13.0` 仍在（改由 loader 动态 import）。基础镜像仍 `node:22-bookworm-slim`，`knowledge-rag-api:local` 现为 902MB（`docker images` 实测）。
  - **重建的镜像**：`api`（`worker` 与 `migrate` 共用同一镜像）与 `web` 都重建；`migrate` 无新迁移（`001_init.sql` / `002_kb_invites.sql` 早已应用），数据库结构零变更
  - **部署事故与处置（务必记住这条）**：`deploy/DEPLOY.md` §2 用的 `tar -czf - … | ssh … tar -xzf -` 是覆盖式解包，**不会删除**本地已删的文件。结果有 7 个本地已删除的源文件（`llm.service.ts`、`sse-parser.ts`、`sse-parser.spec.ts`、`pdf.parser.ts`、`docx.parser.ts`、`prompt.service.ts`、`prompt.service.spec.ts`）仍留在 `/opt/knowledge-rag`，被 `COPY apps/api` 带进构建。其中 5 个非 spec 模块会被 `nest build` 编译进 `dist/` 并进入运行时镜像，生产镜像因此带着一批无人引用的死代码跑了一段时间；另外 2 个 `*.spec.ts`（`sse-parser.spec.ts`、`prompt.service.spec.ts`）由 `apps/api/tsconfig.build.json` 的 `**/*.spec.ts` 排除，不会产出 `dist/` 文件，只在服务器源码树与构建阶段里占着位置。处置：精确删除这 7 个路径后**重建 api**（只删文件不改镜像是无效的）。2026-10-23 复核已过——`/opt/knowledge-rag/apps/api/src/{llm,chat,ingestion/parsing}` 与运行容器内 `dist/llm`、`dist/chat`、`dist/ingestion/parsing` 都不再有这些模块。防范步骤已写入 `deploy/DEPLOY.md` §2.1
  - **回归**：B8 收口时记录的是后端 14 suites / **72** 单测、9 suites / **30** e2e、前端 **9** 测试；C2（2026-10-23）本地复跑同样结果（两端 `typecheck` 无输出、72 单测、30 e2e、9 前端测试）
  - **生产验收**：`http://<SERVER_IP>:8088/api/health` → `{"status":"ok","db":"ok","queue":"ok"}`；只读数据核对（`docker exec pgvector psql -U postgres -d knowledge_rag -tAc` 计数，不写任何数据）→ users **3** / organizations 2 / knowledge_bases 9 / documents **1** / chunks **5** / `min(vector_dims(embedding))` **1024**，与部署前记录的基线（3 用户 / 1 文档 / 5 片段 / 1024 维）一致，证明既没有误删生产数据也没有重新嵌入。B9 部署时核对过 users/documents/chunks/维度这一组，C2（2026-10-23）再次只读复核仍完全一致（组织与知识库数量本轮未留部署前基线，只记录当前值 2 / 9）。运行内存同样在 C2 复核过（跑的是本轮 LangChain 版镜像）：api 57.7MiB / worker 44.3MiB / web 0.7MiB
  - **部署前置条件（新增）**：B5 起的启动校验会让 `CHUNK_SIZE` / `CHUNK_OVERLAP` 配错时 api 与 worker **直接起不来**，所以重建前必须核对生产 `.env.production` 里这两项。本轮这两个容器能正常启动并通过健康检查，即说明取值合法；2026-10-23 另从运行中的容器 `printenv CHUNK_SIZE CHUNK_OVERLAP` 实测为 `800` / `120`（只取这两个值，未读取 `.env.production` 的其它内容）。注意**漏配不报错**：两项都有同样的默认值 800 / 120，所以「值存在」要单独确认，见 `deploy/DEPLOY.md` §1.1
  - **运维可见的行为差异**：① 检索阶段按「停止生成」不再让前端气泡永久停在「生成中」，改为与其它中断一致的 `chat:done(cancelled:true)`；② 嵌入的 HTTP 请求本身取消不了（`OpenAIEmbeddings@1.7` 的 `embedDocuments(texts)` 没有 signal 通道），中断时调用方立刻解阻、请求在后台跑完且结果被丢弃；③ PDF 超时不再打断在途解析（采用 `PDFLoader` 的已知取舍）。三条的代码位置与排障口径见 `docs/operations.md` §11
  - **回滚方式**：本轮**没有**为旧镜像留版本 tag——compose 把镜像名写死成 `knowledge-rag-api:local` / `knowledge-rag-web:local`，重建只会把 tag 挪到新镜像，旧构建变成无 tag 的悬空镜像，`docker images` 里认不出「上一版」。因此真正的回滚路径是：从 LangChain 回滚基线提交 `a45e432`（B 系列之前的最后一个提交）重新同步源码（并按 `deploy/DEPLOY.md` §2.1 核对删除项）后重建 api（worker 共用同一镜像）。回滚到 `a45e432` 丢掉的是 B1–B8 的 LangChain 链路改造（以及其后的 C1 注释、C2 文档），**不丢** BUG-1 `c4d5ea4`（按 userId 加 KB 成员时的组织归属校验）和 BUG-2 `a45e432`（切知识库重置会话状态）；反之退到迁移前基线 `013b9cc` 会连带撤掉 `c4d5ea4`，把「按 userId 加 KB 成员时不校验组织归属」这个缺陷重新引入——外组织账号与不存在的 id 都能重新写进 `knowledge_base_members`（201 落库，或撞 `user_id` 外键变 500）。要精确界定危害：`KbAccessService.resolve` 的判定 0b（`kb-access.service.ts:70-71`）仍在拦，圈外人拿着这条授权行暂时访问不到库，但成员列表与授权表被污染，且这个人日后一旦加入该组织（邮箱分支或接受邀请），遗留的授权行会立刻生效。所以 `013b9cc` 不是可用目标。数据库本轮无变更，两种回滚都不涉及数据。今后部署前先 `docker tag`，命令见 `deploy/DEPLOY.md` §10
  - **未做**：浏览器端真实问答验收留给用户（本轮不创建生产账号、不上传生产文档）


## 5. 资源与安全现状

- 宿主内存约 1.8GB；运行后 API ~50MB、Worker ~35MB、Web ~3MB —— 这是**首批部署当时的运行内存快照**（LangChain 改造之前），保留作历史对照，不回头改写。第六批改用 LangChain 链路后按同一口径复测的是 api 57.7MiB / worker 44.3MiB / web 0.7MiB，见 §4 第六批「生产验收」那条
- Worker 并发为 1，Node 堆上限 API 256MB / Worker 384MB
- 仅公网开放 8088（及原有 80/8000/3306/5432）；API/Worker 不映射端口
- 当前为 HTTP：
  - `COOKIE_SECURE=false`
  - 后续应绑定域名、启用 HTTPS，并更新 `APP_ORIGIN` / `COOKIE_SECURE`
- 现有 PostgreSQL 5432 对公网开放属于历史配置，建议后续收敛

## 6. 复用命令

```bash
cd /opt/knowledge-rag/deploy
docker compose --env-file .env.production -p knowledge-rag ps
docker compose --env-file .env.production -p knowledge-rag logs --tail=100 api
curl -fsS http://127.0.0.1:8088/api/health
```

## 7. 回滚

```bash
cd /opt/knowledge-rag/deploy
docker compose --env-file .env.production -p knowledge-rag down
```

保留 `knowledge_rag` 与上传卷。删除数据库/卷属于破坏性操作，需单独确认。

## 8. 已知限制

- 无邮件验证、密码找回、邮件邀请（邀请链接需手动复制）
- 单 API 实例，WebSocket 不支持横向扩展
- 扫描版 PDF 不做 OCR；旧版 `.doc` 不支持
- 当前无自动备份任务，备份命令见 `deploy/DEPLOY.md` 与 `docs/operations.md`
- HTTPS 尚未配置
