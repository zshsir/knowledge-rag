# 运维手册

生产目录：`/opt/knowledge-rag`  
Compose：`deploy/docker-compose.yml` + `deploy/.env.production`  
项目名：`knowledge-rag`

## 1. 日常检查

```bash
cd /opt/knowledge-rag/deploy
docker compose --env-file .env.production -p knowledge-rag ps
curl -fsS http://127.0.0.1:8088/api/health
docker compose --env-file .env.production -p knowledge-rag logs --tail=120 api
docker compose --env-file .env.production -p knowledge-rag logs --tail=120 worker
free -h
docker stats --no-stream
```

健康检查应返回：

```json
{"status":"ok","db":"ok","queue":"ok"}
```

## 2. 重启与日志

```bash
# 仅重启 API
docker compose --env-file .env.production -p knowledge-rag restart api

# 重启 Worker（不会删除队列任务）
docker compose --env-file .env.production -p knowledge-rag restart worker

# 持续查看日志
docker compose --env-file .env.production -p knowledge-rag logs -f api worker
```

不要重启或修改 `xflow-*`、`travel-*`、`pgvector`、`my-mysql` 等现有服务。

## 3. 升级应用

1. 本地完成 `npm run typecheck`、`npm test`、`npm run test:e2e -w @knowledge-rag/api`、`npm run build`
2. 备份数据库与上传卷（见下一节）
3. 上传新代码到 `/opt/knowledge-rag`（排除 node_modules、dist、.env、storage）
4. **核对删除项**：`tar -x` 是覆盖式解包，**不会删除**本地已经删掉的文件；不核对就会把上一版源码留在服务器上并编进镜像（2026-10-23 LangChain 部署真出过这件事，见 `deploy/DEPLOY.md` §2.1）。按 §2.1 的三种做法之一处理，清完必须重建镜像。
5. 若改过 `.env.production`，先确认八项数值配置存在且合规（切分两项 + `RETRIEVAL_MIN_SCORE` / `RETRIEVAL_TOP_K` / `MAX_UPLOAD_MB` / `WORKER_CONCURRENCY` / `SESSION_TTL_DAYS` / `BCRYPT_ROUNDS`）——配错会让 api 与 worker 直接启动失败（见 §11.4 与 `deploy/DEPLOY.md` §1.1）。
6. 串行构建：

```bash
cd /opt/knowledge-rag/deploy
docker compose --env-file .env.production -p knowledge-rag build api
docker compose --env-file .env.production -p knowledge-rag build web
docker compose --env-file .env.production -p knowledge-rag up -d --force-recreate
```

`migrate` 服务会先执行并退出，API/Worker 随后启动。升级后重新检查 `/api/health` 与关键业务路径。

依赖升级或「清理未使用依赖」之前，先读 §11.6：`mammoth` 与 `pdf-parse` 是 loader 动态 `await import()` 的承重依赖，`@langchain/community` 已在上游废弃但本仓库仍在用。

## 4. 数据备份

```bash
mkdir -p /opt/knowledge-rag/backups
docker exec pgvector pg_dump -U postgres knowledge_rag \
  > /opt/knowledge-rag/backups/knowledge_rag-$(date +%F).sql

docker run --rm \
  -v knowledge-rag_uploads_data:/data \
  -v /opt/knowledge-rag/backups:/backup \
  alpine tar -czf /backup/uploads-$(date +%F).tar.gz -C /data .
```

建议每日执行并保留至少 7 天；备份文件包含用户数据，注意权限与访问控制。

## 5. 数据恢复

恢复会覆盖当前数据，执行前先确认并停止 API/Worker：

```bash
cd /opt/knowledge-rag/deploy
docker compose --env-file .env.production -p knowledge-rag stop api worker
cat /opt/knowledge-rag/backups/knowledge_rag-YYYY-MM-DD.sql \
  | docker exec -i pgvector psql -U postgres knowledge_rag
docker compose --env-file .env.production -p knowledge-rag start api worker
```

上传卷恢复：

```bash
docker run --rm \
  -v knowledge-rag_uploads_data:/data \
  -v /opt/knowledge-rag/backups:/backup \
  alpine sh -c 'cd /data && tar -xzf /backup/uploads-YYYY-MM-DD.tar.gz'
```

## 6. 数据库隔离

- 本地开发：`knowledge_rag_dev`
- 自动化测试：`knowledge_rag_test`
- 生产：`knowledge_rag`

不要把本地 `.env` 指向生产库；生产测试数据会直接进入真实环境。部署与开发使用不同的 env 文件。

## 7. 队列与文件

- pg-boss 队列位于生产数据库的 `pgboss` schema；没有 Redis。
- 任务重试 2 次；失败的文档可在 UI 中重新处理。
- 原文件位于 Docker 卷 `knowledge-rag_uploads_data` 的 `/data/uploads/orgs/...`。
- 删除文档/知识库会同时清理数据库记录和对应文件目录。

## 8. 密钥与配置

- 生产配置：`/opt/knowledge-rag/deploy/.env.production`（`chmod 600`，不提交仓库）
- 修改 API Key、模型、DB 配置后，重启 `api` 与 `worker`：

```bash
cd /opt/knowledge-rag/deploy
docker compose --env-file .env.production -p knowledge-rag up -d --force-recreate api worker
```

- 当前数据库使用现有 `postgres` 超级用户；后续建议创建最小权限账号。
- 不要在聊天、日志、截图中输出 `API_KEY`、`DB_PASSWORD`。
- 这个文件现在还是**启动闸口**：`DB_HOST` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` / `APP_ORIGIN` / `API_KEY` / `BASE_URL` 缺任一，或八项数值配置（`CHUNK_SIZE` / `CHUNK_OVERLAP` / `RETRIEVAL_MIN_SCORE` / `RETRIEVAL_TOP_K` / `MAX_UPLOAD_MB` / `WORKER_CONCURRENCY` / `SESSION_TTL_DAYS` / `BCRYPT_ROUNDS`）配错，api 与 worker 都会拒绝启动（`apps/api/src/config/config.service.ts` 的 `onModuleInit()` → `assertChunkingConfig()` / `assertNumeric()`，逐项规则见 §11.4）。改完配置起不来时先看这两个容器的日志首屏，报错误案里只有变量名和取值，不含密钥。

## 9. HTTPS 升级（后续）

1. 绑定域名并配置 DNS
2. 使用 Nginx + certbot 或阿里云证书提供 TLS
3. 更新 `.env.production`：
   - `APP_ORIGIN=https://your-domain`
   - `COOKIE_SECURE=true`
4. 重启 `api`（Worker 不依赖 Cookie，但可一并重启）
5. 强制用户重新登录；旧 Cookie 不会带 Secure 标记

## 10. 资源与容量

- ECS 2 vCPU / 1.8GB 内存；Worker 固定单并发
- 不要随意调大 `WORKER_CONCURRENCY`；PDF 解析与 Embedding 较耗内存
- 构建镜像必须串行，避免 OOM
- 如需扩容，优先升级 ECS 内存并增加 Worker 并发上限，同时保留单 API 实例的 WebSocket 约束

## 11. 排障：RAG 链路（LangChain 迁移后）

文件路径都相对仓库根，代码在 `/opt/knowledge-rag` 同步下来的源码树里可直接对照。例外：`node_modules/...` 开头的第三方指针只能在**本地工作区**打开——`deploy/DEPLOY.md` §2 的上传管道排除了 `node_modules`，服务器上没有这些文件；另外本仓库是 npm workspace，`@langchain/core`、`@langchain/openai`、`@langchain/textsplitters` 与 `pdf-parse`/`mammoth` 都装在工作区根 `node_modules`，只有 `@langchain/community` 留在 `apps/api/node_modules`。

### 11.1 PDF 被拒：`PDF 页数超过 200 页` / `PDF 解析失败：…`

看 `apps/api/src/ingestion/parsing/pdf-pages.ts` 与 `apps/api/src/ingestion/parsing/parser.service.ts`。

- 页数上限 `MAX_PDF_PAGES = 200`、单次超时 `PDF_PARSE_TIMEOUT_MS = 60_000` 都在 `pdf-pages.ts:10-13`；上限检查在 `assertPdfPageCount()`（`:19-23`），文案就是 `PDF 页数超过 200 页`。
- 实现顺序是「先探页数、再解正文」：`loadPdf()` 用 `pdf-parse` 的 `PDFParse.getInfo()` 只读元数据（`parser.service.ts:115-130`），通过后才让 `PDFLoader` 取文本（`:132-137`）。探测与正文**各算一次 60s**，不是整篇的总预算。
- 归一化后正文短于 20 字符按扫描件拒绝，抛 `PDF 未包含可提取文本，可能是扫描件`（`:142-144`）。这个长度闸口**只对 PDF 生效**，TXT/MD/DOCX 只拒绝空内容。
- 除上述业务 400 之外的任何异常（含超时）都被包成 `PDF 解析失败：<原始 message>` 的 400（`:146-151`）。因为是 400，`IngestionService` 判它「永久失败、不消耗队列重试」（`ingestion.service.ts:141`），文档停在 `failed`，前端看到的是解析文案；要重跑只能在 UI 里重新处理。
- 已知取舍：超时**不会**打断在途解析。`PDFLoader` 不交出它内部的 `PDFParse` 实例，它自己的 `finally` 要等 `getText/getInfo` 落定才 `destroy()`（`apps/api/node_modules/@langchain/community@1.1.29` 的 `dist/document_loaders/fs/pdf.js:99-100`、`:132-133`），所以超时后 pdf.js 仍会跑完并继续占着 buffer，内存风险只由 200 页上限兜着（注意它约束的是页数不是字节数）。说明见 `pdf-pages.ts:25-33`。

### 11.2 `Embedding 维度不正确，期望 1024` / `Embedding 返回数量不正确`

看 `apps/api/src/llm/embeddings.service.ts`：每批返回先校验**条数**必须等于该批请求条数（`:102-104`），再逐条校验**维度**等于 `config.embedding.dimensions`（`:105-111`）。批次大小 16 是自设的（`:14`）——SDK 那一层的默认值是 512（工作区根 `node_modules/@langchain/openai/dist/embeddings.js:28`，字段声明 `embeddings.d.ts:35`/`:67`），我们每批只喂 ≤16 条，所以 SDK 内部不会再切一次（我们没覆盖 SDK 的 `batchSize`，把请求压小的是本服务的循环）。这两个错抛的是 `LlmError`，不是 400，因此 pg-boss 会按可重试错误重试。

- 注意：**启动时不校验** `EMBEDDING_DIMENSIONS` 与 `chunks.embedding` 的 `vector(1024)` 列是否一致。`AppConfigService.onModuleInit()` 查的是 DB 四项 + `APP_ORIGIN` + `API_KEY` + `BASE_URL` + 八项数值配置（`config/config.service.ts` 的 `onModuleInit()`，见 §11.4），而列上的 1024 写死在 `apps/api/migrations/001_init.sql:104`。两种配错的失败点不一样：
  - 模型返回的维度 ≠ `EMBEDDING_DIMENSIONS` → 在 `embed()` 就抛 `Embedding 维度不正确`，入库任务失败（可重试错误）；
  - 模型返回的维度 = `EMBEDDING_DIMENSIONS` ≠ 列的 1024（比如把环境变量改成 768 且模型真给 768）→ 自检放行，**直到 `INSERT INTO chunks` 才由 Postgres 报维度错误**（`ingestion.service.ts:110-124` 就是那条 INSERT）。
- 因此真要换嵌入模型/维度：改 `EMBEDDING_DIMENSIONS` 只是改自检期望值，**不会**重建已有切片，也不会改表结构；必须同步改迁移并重跑全部文档的嵌入，否则新旧向量在同一列里混着，检索时按维度报错。

### 11.3 「停止生成」到底断了什么

看 `apps/api/src/chat/chat.service.ts`、`apps/api/src/realtime/realtime.gateway.ts`、`apps/api/src/llm/embeddings.service.ts`。

- **生成阶段**按停止：已生成的半条回答以 `interrupted = true` 落库（`chat.service.ts:235-255`），网关随后照常推 `chat:done`，载荷里 `cancelled: true`（`realtime.gateway.ts` 的 `#chatSend` 第 9 步）；`chat:error` 不会发，前端不该弹错误。
- **检索阶段**（还在算问题向量或查库）按停止：本次迁移起也归为中断——不落助手行、不推 `chat:meta`，直接返回 `interrupted: true` ⇒ 前端同样收到 `cancelled: true` 的 `chat:done`（`chat.service.ts:181-199`）。修复前这条分支会把异常抛到网关的 catch，那时见 `signal.aborted` 就既不发 error 也不发 done，**气泡会永久停在「生成中」**。今天网关多了一条兜底（`#chatSend` 第 10b 步：补发 `chat:done{assistantMessageId:null, cancelled:true}`），所以「永不结束」这个最坏结果已经堵死；但兜底那条带不出引用、也只能退回请求里带的会话 id（新对话时是空串），所以中断分类仍然必须留在 `ChatService` 里。
- 中断的判据是 `signal.aborted || error.name === 'AbortError'`（`chat.service.ts:66-68`），检索与生成两段共用；`EmbeddingsService` 自己造的取消错误刻意命名成 `AbortError`（`embeddings.service.ts:28-32`）。
- **嵌入的 HTTP 请求本身取消不了**：`OpenAIEmbeddings@1.7` 的 `embedDocuments(texts)` 只接收文本数组、忽略我们传的 signal（工作区根 `node_modules/@langchain/openai/dist/embeddings.d.ts:98`；顺带记录该类 `batchSize` 的默认值 512 在 `dist/embeddings.js:28`，字段声明 `embeddings.d.ts:35`/`:67`）。`EmbeddingsService` 于是在外面做两层——派发前查 `signal.aborted`（`:93-95`）、等待时与 abort 竞争一次（`:44-64`）。效果是**调用方立刻解阻**，而那次 HTTP（最多 3 次重试、单次 60s 超时，`llm.module.ts:88-89`）仍在后台跑到结束，结果没人用。所以「按了停止但上游还有一次调用」是预期行为，不是 bug。
- 对话这一侧不同：`streamEvents({ signal, timeout })` 会真正掐断请求（`chat-model.service.ts` 的 `#stream`，实测说明见 `chat.service.ts:53-59`）。
- **5 分钟那个 `timeout` 是这一轮调用的端到端上界**，不是「只作用于单次 HTTP 请求」的摆设：core 的 `ensureConfig` 把它换成 `AbortSignal.timeout(ms)` 并与调用方 signal 用 `AbortSignal.any` 合成（工作区根 `node_modules/@langchain/core/dist/runnables/config.js:105-120`），`runnables/base.js:128-154` 只是从 callOptions 里删掉 `timeout` 这个键，随后 `_separateRunnableConfigFromCallOptionsCompat`（`language_models/chat_models.js:71-75`）把合成后的 signal 重新挂回 `callOptions.signal`，最后由 `@langchain/openai/dist/chat_models/completions.js:171` 的流式分支 `_streamChatModelEvents` 用 `completionWithRetry(params, options)` 把整份 options（含合成 signal）交给 SDK、`:173-179` 用 `abortableStream` 包住流（同文件 `:116` 那份 `signal: options?.signal` 是非流式分支，不在这条链路上）。实测守卫在 `apps/api/src/llm/chat-model.service.spec.ts` 的第二组用例（真实 `ChatOpenAI` 打一个只接受不作答的本地服务：`timeout: 500` 的抛出被钉在 300–2000ms 的断言带内——具体毫秒数随机器漂移，文档与注释都不写死；`timeout: 2000` 在 800ms 那刻仍在挂）。
- **超时到点怎么归类（排障时最容易看错的一条）**：错误的形状随环境而变——jest 环境里实测 `name` 是 `'Error'`（message 为 `Aborted`），那是 jest-environment 的产物；纯 Node 脚本复现同一条链，抛的是 `name` 为 `'TimeoutError'` 的 `DOMException`（message "The operation was aborted due to timeout"）。两种环境的 `name` 都**不是** `AbortError` ⇒ `chat.service.ts:66-68` 的 `isAbort()` 判为故障而不是用户取消 ⇒ 已生成的半条回答以 `interrupted: true` 落库（`chat.service.ts:239-248`）后错误重新抛出，网关按真故障处理 ⇒ 推 `chat:error`、前端结束流式态并提示失败——这个归类结论与环境无关。这是刻意保留的分类（超时本来就是故障而不是「点了停止」），不要为了「让它看起来像取消」去放宽 `isAbort`。

### 11.4 数值配置：配错 = 起不来（切分两项 + 其余六项）

看 `apps/api/src/config/config.service.ts`：`onModuleInit()` 依次调 `assertChunkingConfig()`（切分两项，文案与分支被 `config.service.spec.ts` 逐条钉住）和 `assertNumeric()`（其余六项共用同一个判据）。

- 规则：
  - `CHUNK_SIZE` 必须是 ≥1 的整数；`CHUNK_OVERLAP` 必须是 ≥0 的整数且**严格小于** `CHUNK_SIZE`
  - `RETRIEVAL_MIN_SCORE` 必须是 >0 且 ≤1 的有限数字
  - `RETRIEVAL_TOP_K` / `MAX_UPLOAD_MB` / `WORKER_CONCURRENCY` / `SESSION_TTL_DAYS` 必须是 ≥1 的整数
  - `BCRYPT_ROUNDS` 必须是 4..31 的整数（bcryptjs 的有效 cost 定义域；下界 4 是本仓库 `test/setup-env.ts` 给单测与 e2e 用的提速值）
  违反就抛 `变量名 配置无效（原值 …，读到 …）：必须是 …`，报错只点名变量名与取值，不含密钥，可以直接看日志。
- 后五项是 2026-10-24 修复波纳入的。此前它们走裸 `Number(env)`，配错**不报错、只把功能悄悄改掉**，每一条都比切分那两条更隐蔽：
  - `RETRIEVAL_MIN_SCORE` → NaN：`retrieval.service.ts` 的 `row.score >= NaN` 恒为 false ⇒ 每次提问都回「知识库中没有找到足够的信息…」，而 `/api/health` 一路绿灯（严格静默的 RAG 停摆）
  - `RETRIEVAL_TOP_K` → 空值得 0：SQL 直接 `LIMIT 0`，症状与上一条一模一样
  - `MAX_UPLOAD_MB` → NaN：`document-validation.ts` 的体积判断永不触发，只剩 `documents.controller.ts` 里写死的 multer 25MB
  - `WORKER_CONCURRENCY` → NaN：`Math.max(1, NaN)` 仍是 NaN，`queue.service.ts` 的 for 循环注册出 0 个 worker，日志打 `concurrency=NaN`，进程看着活着却永远不取任务
  - `SESSION_TTL_DAYS` → NaN：会话到期时间写成 Invalid Date，过期逻辑静默失真
- `BCRYPT_ROUNDS` 是随后（final-fix Item A）纳入的，此前排除它的理由是「bcryptjs 自己会拒绝非法 cost」——实测安装的 bcryptjs 3.0.3 并不成立：cost 传 `NaN` 或 `0` 时 `hashSync` 照样出哈希、轮数是 **10**，传 `-1` 或 `3` 出 **04**，只有小数 cost 才在哈希时抛 `Missing salt rounds`。也就是说 `BCRYPT_ROUNDS=abc` 不报错、不把进程拦下，只是把新建哈希从默认 12 轮悄悄降到 10（或 04），登录注册一切如常——正是这道闸口要消灭的静默路径，所以它必须启动即校验。合法域 4..31 即 bcryptjs 的 cost 定义域，用例见 `config.service.spec.ts` 数值组（`abc`/`0`/`32`/空值拒绝，漏配/`4`/`31` 放行）。
- **部署后果（与 B5 那次同一性质）**：上一版能启动的 `.env.production`，只要这些数值项里任何一项是空值、纯空白、拼错的字母或越界数字，这一版就**拒绝启动**，表现为 api 与 worker 容器反复重启、健康检查不过。所以每次重建前按 `deploy/DEPLOY.md` §1.1 的 grep 把这八项各看一眼。
- 生效范围是 **api 和 worker 两个进程**（两者都 import `AppConfigModule`：`app.module.ts:32`、`worker.module.ts:22`），所以配错的表现是容器起不来，而不是功能质量变差。
- 漏配与空值的口径不同，别混：**整行不写**走默认值、不报错（八项都有默认值 800 / 120 / 0.2 / 6 / 20 / 1 / 7 / 12）；**写了空值**只有 `CHUNK_OVERLAP=` 仍算合法（0 表示不重叠，这是切分闸口的既有特例，保持原样没动），其余六项都判非法。
- 为什么值得这么拦：切分器为了参数合法会把越界值夹到 `size - 1`（`ingestion/parsing/chunker.ts:42-47`），不拦的话 `CHUNK_SIZE=`（空 → 0）、拼错字母（→ NaN）、`800.5`（→ 小数）都能「正常启动」，代价是整篇塌成一片超长文本或块数暴涨，且没有任何报错。其余六项的「静默」形态见上面那份清单。
- 刻意**没有**纳入的三项也记在这里，免得下次误加：`PORT` / `DB_PORT`（NaN 会让 `app.listen`、`pg` 在启动那一刻直接抛错，没有静默路径）、`EMBEDDING_DIMENSIONS`（维度是逐向量对着 provider 返回值校验的，见 §11.2；与 `vector(1024)` 列的启动交叉校验属于另一件事，仍未做）。（`BCRYPT_ROUNDS` 原在本清单里、理由写的也是「bcryptjs 自己拒绝非法 cost」——上面那条实测推翻了它，已移进闸口，勿再加回。）

### 11.5 其它常见现象

- 文档停在 `failed` 且 `error` 带 `文档内容为空`（TXT/MD 解码后为空，`parsing/text.parser.ts:66-68`）或 `DOCX 未包含可提取文本`（`parsing/parser.service.ts:165-167`）：都是内容问题，属永久失败，不重试。
- 回答里引用编号和片段内容错位：引用编号是 `RetrievalService` 在阈值过滤**之后**从 1 开始重排的（`chat/retrieval.service.ts:88-100`，SQL 本身不给编号），提示词用同一份 `sources` 渲染（`chat/rag-prompt.ts:49-57`），一次问答只检索一次（`chat.service.ts:171-186`）——如果将来有人把检索塞回链内部，这里就会错。
- 中文文档切片质量突然退化：先确认 `splitToChunks()` 的中文分隔符还在（`ingestion/parsing/chunker.ts:15`）。
- 模型只回了空白（`chat.service.ts:269-277`）：本次**不落助手行**，所以会话历史里会留下一个「只有问句、没有回答」的尾巴，且收尾是 `chat:done{cancelled:false}`（不是 error、也没有「已停止生成」徽标）。这是刻意的设计；被 `chat.service.spec.ts:312` 当作契约钉住的是它「不落库」那一半（断言 `answer` 为空串、`assistantMessageId` 为 null、`messages.insert` 只写了用户那一行、`conversations.touch` 未被调用），该用例没有断言 `interrupted`/`cancelled` 这两个收尾字段；用户看不到任何失败提示，排查时按 `conversation_id` 查 `messages` 数一下角色即可确认。

### 11.6 依赖现状：`@langchain/community` 已在上游废弃

- `package-lock.json:93` 带着 `"deprecated": "This package has been deprecated. See …/langchainjs-community/issues/61"`（上游 issue #61）。本仓库从 B 系列起只用到它的两个薄封装：`PDFLoader` 与 `DocxLoader`（`ingestion/parsing/parser.service.ts`）。
- 代价：它把 `@langchain/classic@1.0.55` 和**第二份** `openai@4.104.0` 一起拖进镜像（`package-lock.json:89`、`:583`，第二份 openai 的 `resolved` 行当前在 `:11854`），而 `knowledge-rag-api:local` 已经 902MB（见 `deploy/DEPLOY.md` §4）。
- 最便宜的收尾动作：把这两个 loader 换成直接调用 `pdf-parse` / `mammoth`（两者本来就已声明为直接依赖），community 就能整个摘掉，`@langchain/classic` 与第二份 `openai` 随之消失。本轮**没有**做——那是行为变更（PDF 分页拼接、异常文案、空白页处理都会变，且要重跑解析相关的 e2e 与单测），要单独决策。留在这里是给下一次依赖清理时先看的那条最省力的路。
- 升级 / 清理依赖前必须知道的承重关系（`apps/api/package.json:36-37`）：`mammoth` 在整个 src 里【没有任何直接 import】、`pdf-parse` 也只被页数探测那一处直接 import（`parser.service.ts:115`），看起来像 Unused dependency，实际上两者都是 `PDFLoader` / `DocxLoader` 内部动态 `await import()` 的目标，删掉就会在解析层静默坏掉。守这条的用例是 `parsers.spec.ts` 里的 PDF/DOCX 那组（只有 CI 会跑到），别按静态 import 检查的结果删它们。
- 动手顺序建议：先在本地把 community 摘掉跑 `npm run test` + `npm run test:e2e`（§3 的第 1 步），确认解析行为没有回退，再考虑镜像体积收益。
