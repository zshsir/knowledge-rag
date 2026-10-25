# Atlas · 阿里云 ECS 部署说明

目标服务器：`<SERVER_IP>`（root，已配置 SSH 密钥别名 `<SSH_HOST>`）
部署目录：`/opt/knowledge-rag`
Compose 项目名：`knowledge-rag`
公网入口：`http://<SERVER_IP>:8088`（可通过 `APP_PORT` 调整）
数据库：复用现有 `pgvector` 容器（PostgreSQL 15 + pgvector），新建 `knowledge_rag` 库
已有服务（80/8000/3306/5432 及 xflow/travel 容器）**不得修改或重启**

## 0. 前置检查

```bash
ssh <SSH_HOST>
docker --version          # 24.0.9
docker compose version    # v2.27.0
ss -tlnp | grep ':8088'   # 应为空
free -h                   # 目标机 1.8GB 内存，构建需串行
```

服务器审计基线见设计文档 §17.7。

阿里云安全组入方向需放行 TCP `8088`（以及 SSH 22）。只暴露 Web 端口，API/Worker 不映射到宿主机。

## 1. 准备生产环境变量

本地在 `deploy/.env.production` 填写（可从 `.env.production.example` 复制）：

- `APP_ORIGIN` 必须与浏览器实际访问地址完全一致（含端口）
- `COOKIE_SECURE=false`（当前 HTTP 访问）
- `DB_HOST=host.docker.internal`，`DB_NAME=knowledge_rag`
- `API_KEY`、`DB_PASSWORD` 使用真实值
- `UPLOAD_DIR=/data/uploads`

将文件传到服务器：

```bash
scp deploy/.env.production <SSH_HOST>:/opt/knowledge-rag/deploy/.env.production
```

不要把该文件提交到仓库或输出到日志。

### 1.1 启动配置校验（重建 api/worker 之前必须核对）

后端在启动阶段就校验**八项数值配置**，配错**直接让进程起不来**（不是降级跑），且 api 与 worker 都装了配置模块，两个容器一起挂：

- `CHUNK_SIZE`：必须是 ≥1 的整数
- `CHUNK_OVERLAP`：必须是 ≥0 且严格小于 `CHUNK_SIZE` 的整数
- `RETRIEVAL_MIN_SCORE`：必须是 >0 且 ≤1 的有限数字
- `RETRIEVAL_TOP_K`：必须是 ≥1 的整数
- `MAX_UPLOAD_MB`：必须是 ≥1 的整数
- `WORKER_CONCURRENCY`：必须是 ≥1 的整数
- `SESSION_TTL_DAYS`：必须是 ≥1 的整数
- `BCRYPT_ROUNDS`：必须是 4..31 的整数（bcryptjs 的有效 cost 域；实测它对非法值**不**报错，NaN/0 静默按 10、-1/3 静默按 04，只会悄悄弱化新哈希，所以必须启动即校验——final-fix Item A 纳入）

校验点与报错文案见 `apps/api/src/config/config.service.ts`（`onModuleInit` → `assertChunkingConfig()` 与 `assertNumeric()`）。

**后五项是 2026-10-24 修复波新加的闸口**，为什么那时才加：这五项配错过去【不报错】，只把功能悄悄改掉——`RETRIEVAL_MIN_SCORE` 得到 NaN 后 `score >= NaN` 恒为 false，于是每次提问都回「没找到资料」而 `/api/health` 一路绿灯；`RETRIEVAL_TOP_K` 写成空值得到 0，SQL 直接 `LIMIT 0`；`MAX_UPLOAD_MB` 得到 NaN 后体积校验永不触发；`WORKER_CONCURRENCY` 得到 NaN 后 `Math.max(1, NaN)` 仍是 NaN，worker 进程活着但一个任务都不取；`SESSION_TTL_DAYS` 得到 NaN 后会话到期时间写成 Invalid Date。现在这些一律变成启动失败。**部署后果**：上一版能启动的 `.env.production`，只要其中任何一项写成空值、纯空白、拼错的字母或越界数字，这一版就会拒绝启动（表现为 api/worker 容器反复重启、健康检查不过）。所以下次部署【动手前】先把上面列出的八项各看一眼，而不只是看切分两项（`BCRYPT_ROUNDS` 是 final-fix Item A 之后追加的第八项）。

两条取值口径要分清楚：

- **漏配（整行不写）不报错**：八项都有默认值（800 / 120 / 0.2 / 6 / 20 / 1 / 7 / 12），没写照样启动、只是静默用默认值，所以要确认的是「存在且是业务想要的那对值」
- **写了空值会报错**：`RETRIEVAL_MIN_SCORE=`（或只有空格）属于非法，`Number('')` 得到 0 这条路已经被拦掉；要么填合法值，要么整行删掉走默认值。切分两项里只有 `CHUNK_OVERLAP=` 仍算合法（0 表示不重叠），别把这条特例外推到其余六项

核对方式（只回显这八项，不要 `cat` 整个文件，也不要 `docker compose config` 那种会把全部环境变量打进终端的写法）：

```bash
grep -E '^(CHUNK_SIZE|CHUNK_OVERLAP|RETRIEVAL_MIN_SCORE|RETRIEVAL_TOP_K|MAX_UPLOAD_MB|WORKER_CONCURRENCY|SESSION_TTL_DAYS|BCRYPT_ROUNDS)=' \
  /opt/knowledge-rag/deploy/.env.production
```

当前生产切分两项是 `800` / `120`（2026-10-23 从运行中的容器 `printenv` 复核）。其余六项 2026-10-24 起在本地做过**合法性**核对（`BCRYPT_ROUNDS` 于 final-fix 纳入后同样只判「能过闸口」，取值未输出到任何地方），取值以 `.env.production.example` 为基准；下次部署前请用上面那条 grep 亲眼确认这些数值项确实存在、且是业务想要的那几个数。除此之外一份 `.env.production` 里的其它内容一律不要输出到终端、日志或提交里。

## 2. 上传代码

在本地项目根目录执行（排除依赖、构建产物、本地 env、storage）：

```bash
tar -czf - \
  --exclude='node_modules' \
  --exclude='apps/web/dist' \
  --exclude='apps/api/dist' \
  --exclude='.env' \
  --exclude='apps/api/storage' \
  --exclude='apps/api/test/tmp-uploads' \
  . | ssh <SSH_HOST> 'mkdir -p /opt/knowledge-rag && tar -xzf - -C /opt/knowledge-rag'
```

### 2.1 解包后必须核对「本地已删除的文件」（真实事故）

`tar -x` 只覆盖同名文件，**不删除**远端多余文件。所以只要这次改动删过源码，服务器就会把旧文件一直留着，越攒越多。

2026-10-23 的 LangChain 部署就栽在这里：本地在 B7 / B8 删掉的 **7 个源文件**仍然留在 `/opt/knowledge-rag`，被 `COPY apps/api` 带进构建、`nest build` 按 `tsconfig.build.json` 编译（它只排除 `**/*.spec.ts`，非 spec 的旧模块照样产出 `dist/*.js`），于是生产镜像里带着一批无人引用的死代码（旧 `LlmService`、`sse-parser`、`pdf.parser`、`docx.parser`、`prompt.service`），直到人工比对后删掉这 7 个路径并重建 api 才干净。清单（`git log --diff-filter=D --name-only a45e432..ca405a0` 可直接列出）：

```text
apps/api/src/llm/llm.service.ts
apps/api/src/llm/sse-parser.ts
apps/api/src/llm/sse-parser.spec.ts
apps/api/src/ingestion/parsing/pdf.parser.ts
apps/api/src/ingestion/parsing/docx.parser.ts
apps/api/src/chat/prompt.service.ts
apps/api/src/chat/prompt.service.spec.ts
```

三种核对方式，任选一种：

1. **推荐：本地 `git archive` + 只对源码目录做删除对齐**。`git archive` 出的就是提交里的完整树（不含 `node_modules` 等未跟踪文件），再让 `rsync --delete` 把服务器上的源码目录对齐过去。两个前提实测过：`/opt/knowledge-rag` **没有** `.git`（所以只能在本地跑 git），服务器上有 `/usr/bin/rsync`。

```bash
git archive --format=tar.gz HEAD | ssh <SSH_HOST> \
  'set -e
   rm -rf /opt/knowledge-rag-clean && mkdir -p /opt/knowledge-rag-clean
   tar -xzf - -C /opt/knowledge-rag-clean
   # 只对 apps/ 做 --delete：整个部署目录里还有 backups/、deploy/.env.production 这些服务器独有的东西，
   # 对根目录 --delete 会把它们一起删掉
   rsync -a --delete --exclude node_modules /opt/knowledge-rag-clean/apps/ /opt/knowledge-rag/apps/
   rsync -a --exclude apps --exclude node_modules --exclude .env /opt/knowledge-rag-clean/ /opt/knowledge-rag/
   rm -rf /opt/knowledge-rag-clean'
```

2. **先删后解**：继续用第 2 节那条 tar 管道，但解包前把目标源码目录清掉（只清源码目录，别碰 `deploy/.env.production`、`node_modules`、上传卷）：

```bash
ssh <SSH_HOST> 'rm -rf /opt/knowledge-rag/apps/api/src /opt/knowledge-rag/apps/api/test /opt/knowledge-rag/apps/web/src'
# 然后重跑上面第 2 节的 tar 管道
```

   **它清的范围只有这三个目录**，覆盖不到的路径包括 `apps/api/migrations/`（迁移 SQL 会经 `apps/api/Dockerfile:25` 的 `COPY --from=build` 进镜像）、`apps/api` 与 `apps/web` 的 `package.json`、`Dockerfile`、`nest-cli.json`、`jest.config.js`、`tsconfig*.json`，以及仓库根的 `package.json`、`package-lock.json`、`tsconfig.base.json`、`.dockerignore`、`deploy/`、`docs/`。tar 只覆盖同名文件，所以这些位置里「本地已删」的文件一律留着。改动只在三个源码目录里时用这条就够；动过迁移或 `apps/` 下的其它文件就改用方式 1（它对**整个 `apps/`** 做 `rsync --delete`，`migrations` 与 `apps/api` 根级配置都在范围内）。要说清楚：方式 1 也没法清仓库根与 `deploy/`、`docs/` 层被删掉的文件——那条针对根目录的 `rsync` 故意不带 `--delete`，否则会连 `backups/` 和服务器上的 `.env.production` 一起删掉，那一层只能人工核对。

3. **列清单人工核对**（不改动任何东西，适合只删过一两个文件的场合）：本地取 tracked 文件清单，服务器用 `find` 取实际清单（服务器没有 git 仓库，别指望 `git ls-files`），比对后多出来的就是要人工判别的候选：

```bash
git ls-files 'apps/api/src' 'apps/api/test' 'apps/web/src' | LC_ALL=C sort > /tmp/want.txt
ssh <SSH_HOST> 'cd /opt/knowledge-rag && find apps/api/src apps/api/test apps/web/src -type f | LC_ALL=C sort' > /tmp/have.txt
comm -13 /tmp/want.txt /tmp/have.txt      # 只在服务器上有的 = 候选，删前逐条判别
```

   两个 `sort` 都要显式写 `LC_ALL=C`：`comm` 要求两份输入按**同一套**排序规则排好，而本地（Git Bash / Windows）与服务器 shell 的 locale 折叠规则不同（大小写、`-` 与 `.` 的权重），默认 `sort` 会让同一条路径在两边排到不同位置，比对结果全是噪音。还要知道这两份清单口径不一样：`git ls-files` 只列 tracked 文件，`find` 列服务器上真实存在的一切，所以 `.gitignore` 排除、但服务器可能确实有的运行期产物（例如跑过 e2e 就会留下的 `apps/api/test/tmp-uploads/`，`.gitignore:11`）也会落进差集——那是「服务器独有」不是「残留」，不要顺手删。这条比对同样只覆盖那三个路径前缀，`apps/api/migrations`、`apps/api` 与根目录的配置不在其中。

**核对完必须重建镜像**（`docker compose build api web`，随后 `up -d --force-recreate`）——只删服务器上的文件不会改变已经在跑的容器；删干净后建议复核一次产物里确实没有旧模块，例如：

```bash
docker exec knowledge-rag-api-1 sh -c 'ls /app/apps/api/dist/llm /app/apps/api/dist/chat'
```

## 3. 校验 Compose

```bash
cd /opt/knowledge-rag/deploy
docker compose --env-file .env.production -p knowledge-rag config >/dev/null
```

只做配置校验，不启动容器。

## 4. 串行构建镜像（内存受限）

```bash
cd /opt/knowledge-rag/deploy
docker compose --env-file .env.production -p knowledge-rag build api
docker compose --env-file .env.production -p knowledge-rag build web
```

> 目标机仅 1.8GB 内存，**不要并行构建**。如遇 OOM，先停止并检查内存/swap；不要执行 `docker system prune` 或重启现有服务。
>
> 2026-10-23 起依赖里多了四个 LangChain 包，`npm ci` 更慢、镜像更大（`knowledge-rag-api:local` 约 902MB）。构建期 Node 堆上限写在 `apps/api/Dockerfile:3`（`--max-old-space-size=512`），运行期由 compose 分别给 api 256MB / worker 384MB（`deploy/docker-compose.yml:21`、`:45`）。空间紧张时**不要**图省事 `docker system prune -a`——那会连带删掉别的业务在用的镜像；先 `docker images -f dangling=true` 列出无 tag 的构建产物，确认属于本项目、且不是 §10 留的旧版本回滚镜像后再逐个 `docker rmi`。
>
> 想靠「升级依赖 / 清理依赖」把镜像压小之前，先读 `docs/operations.md` §11.6：`@langchain/community` 已在上游废弃（还捎带 `@langchain/classic` 与第二份 `openai`），而 `mammoth` / `pdf-parse` 虽然几乎没有直接 import，却是那两个 loader 动态 `await import()` 的承重依赖，按静态检查结果删除会静默坏掉 PDF/DOCX 解析。

## 5. 启动

```bash
cd /opt/knowledge-rag/deploy
docker compose --env-file .env.production -p knowledge-rag up -d
docker compose --env-file .env.production -p knowledge-rag ps
docker compose --env-file .env.production -p knowledge-rag logs --tail=120 migrate
docker compose --env-file .env.production -p knowledge-rag logs --tail=120 api
```

`migrate` 会创建 `knowledge_rag` 与表结构，然后退出；`api`/`worker`/`web` 启动。

## 6. 调整现有数据库容器重启策略（已获用户授权）

```bash
docker update --restart unless-stopped pgvector
docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' pgvector
```

预期输出 `unless-stopped`，不会中断正在运行的数据库。

## 7. 健康检查与安全组

本地：

```bash
curl -fsS http://<SERVER_IP>:8088/api/health
```

预期：

```json
{"status":"ok","db":"ok","queue":"ok"}
```

若失败：

1. 检查阿里云安全组 8088/TCP 是否放行
2. 检查 `docker compose ps` 中 `api` 是否 healthy
3. 查看 `api`/`worker` 日志
4. 检查现有 80/8000 服务是否仍正常

不要修改或停止现有容器。

## 8. 公网验收清单

1. 打开 `http://<SERVER_IP>:8088`，注册账号
2. 创建知识库，上传 TXT/PDF/DOCX
3. 确认文档状态实时变为「已就绪」，片段数 > 0
4. 提问，确认流式回答、引用卡片、停止生成
5. 邀请第二个账号，验证成员、角色、知识库授权
6. 切换知识库为「指定成员」，确认未授权成员实时被移出
7. 验证原文件下载与跨组织 404
8. 确认 `http://<SERVER_IP>` 的既有 xflow 服务不受影响

## 9. 备份与恢复

```bash
# 数据库
docker exec pgvector pg_dump -U postgres knowledge_rag > /opt/knowledge-rag/backup-$(date +%F).sql

# 上传文件卷
docker run --rm -v knowledge-rag_uploads_data:/data -v /opt/knowledge-rag:/backup \
  alpine tar -czf /backup/uploads-$(date +%F).tar.gz -C /data .
```

恢复前先停 `api` 与 `worker`，恢复后再启动。

## 10. 回滚

`down` 只是停服，**不是回滚版本**。要回滚到上一版代码，前提是那一版还有可指回去的 tag——而 compose 把镜像名写死成 `knowledge-rag-api:local` / `knowledge-rag-web:local`，重建只会把这个名字挪到新镜像，旧构建变成**无 tag 的悬空镜像**（`docker images` 里全是 `<none>`，认不出哪个是上一版）。2026-10-23 的 LangChain 部署就没有留下旧 tag，当时能用的回滚手段只有：从 **LangChain 回滚基线提交 `a45e432`**（B 系列之前的最后一个提交）重新同步源码（并先按 §2.1 核对删除项）再重建 api（`worker` 共用同一镜像）。回滚到 `a45e432` 丢掉的是 B1–B8 的 LangChain 链路改造，**以及其后的 C1 测试注释与 C2 文档同步**（口径与 `docs/deployment-record.md` §4 第六批「回滚方式」一致）；**保住** BUG-1 `c4d5ea4`（按 userId 加 KB 成员时的组织归属校验）与 BUG-2 `a45e432`（切知识库重置会话状态）；**不要**退到更早的迁移前基线 `013b9cc`——它在 `c4d5ea4` 之前，退回那里等于把「外组织 userId 也能被写进 `knowledge_base_members`」的缺陷重新引入（危害边界与代码位置见 `docs/deployment-record.md` §4 第六批「回滚方式」）。数据库无变更，两种回滚都不涉及数据。

还有一个自指的坑要记住：**回滚到 `a45e432` 会连本文件 §2.1 那套「核对本地已删除文件」的流程一起退掉**（那一节是第六批才写进来的，`a45e432` 里没有）。所以真要回滚时，删除项核对必须自己重新推一遍，不能指望目标版本的操作手册：

```bash
# 列出从回滚目标到当前 HEAD 之间被删掉的文件，逐个到 /opt/knowledge-rag 确认是否还留着旧副本
git log --diff-filter=D --name-only a45e432..HEAD
```

因此每次部署**动手前**先给当前在跑的镜像打版本 tag：

```bash
cd /opt/knowledge-rag/deploy
docker tag knowledge-rag-api:local knowledge-rag-api:$(date +%F)-pre   # worker 与 api 共用同一镜像
docker tag knowledge-rag-web:local knowledge-rag-web:$(date +%F)-pre
```

真要回滚时（数据库本轮无变更，回滚不涉及数据）——把下面两处 `2026-10-23-pre` 换成你实际打过的、并且 `docker images` 里确实还在的那个 tag：

```bash
cd /opt/knowledge-rag/deploy
docker tag knowledge-rag-api:2026-10-23-pre knowledge-rag-api:local
docker tag knowledge-rag-web:2026-10-23-pre knowledge-rag-web:local
docker compose --env-file .env.production -p knowledge-rag up -d --force-recreate --no-deps api worker web
```

停服与彻底清理：

```bash
cd /opt/knowledge-rag/deploy
docker compose --env-file .env.production -p knowledge-rag down
```

默认保留上传卷和 `knowledge_rag` 数据库。彻底清理数据属于破坏性操作，需要单独确认。

## 11. 注意事项

- 当前为 HTTP 访问，Session Cookie 未启用 Secure；建议尽快绑定域名并启用 HTTPS，同时将 `COOKIE_SECURE=true`、更新 `APP_ORIGIN`。
- `pgvector` 容器原本 `restart=no`，已建议并执行改为 `unless-stopped`。
- 服务器内存紧张，Worker 固定单并发；不要随意调大 `WORKER_CONCURRENCY`。
- 现有 PostgreSQL 5432 对公网开放属于历史配置；后续建议收敛到内网/白名单，并使用最小权限数据库账号。
- 部署完成后记录镜像版本、构建时间、验收结果与测试账号（不含密码）。
