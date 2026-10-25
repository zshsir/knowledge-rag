# LangChain 迁移设计（knowledge-rag 后端 RAG 链路）

日期：2026-10-23
状态：已实现并部署。B 系列实现提交范围 `ecbdbd3..ca405a0`（B1–B8，含每轮评审修正提交），分支 `sdd/langchain-migration`；测试注释为 `4b56d2e..5f62df0`（C1）。生产部署与验收见 `docs/deployment-record.md` 的「第六批」。本文件中标注「实现结果」的段落是落地后回写的更正，与原设计的差异以这些标注为准；其中的代码路径除注明外都相对 `apps/api/src`。
范围：`apps/api` 的解析、切分、嵌入、检索、问答生成链路；`apps/web` 与数据库结构不变

## 1. 背景与目标

当前 RAG 链路全部手写：`fetch` 直连 SiliconFlow、手写 SSE 解析、手写切分、手写 pgvector SQL。用户要求全面改用 LangChain 实现，同时保留已验证的多租户隔离与生产可用性。

目标：

1. 解析、切分、模型调用、检索编排改用 LangChain 标准抽象（Document / DocumentLoader / TextSplitter / Embeddings / BaseChatModel / BaseRetriever / LCEL Runnable）
2. 对外行为零变化：REST 接口、WebSocket 事件协议（`chat:send/meta/delta/done/error`）、前端代码、数据库结构与生产数据全部不动
3. 多租户隔离与「只检索 ready 文档」的约束不得弱化
4. 新写的代码从一开始就带中文注释（做什么 + 为什么 + 步骤编号）

非目标：不引入 Agent/工具调用、不引入 LangSmith 追踪、不换向量库、不改前端。

> 实现结果（目标 2 的唯一例外）：REST 接口、WS 事件协议、前端代码与数据库结构确实未变。行为差异只有一处——「检索阶段被取消」的归类：原设计没覆盖这条分支，实现期评审把它从「既不发 `chat:error` 也不发 `chat:done`（前端气泡永久停在生成中）」改成与其它中断一致的 `chat:done(cancelled:true)`（`chat/chat.service.ts:178-196`）。

## 2. 关键决策

### 2.1 向量存储：不用 PGVectorStore，改用自定义 BaseRetriever（已确认）

否决 `PGVectorStore` 的原因（基于 `@langchain/community@1.1.29` 源码核实）：

1. 它只能管理自己创建的表结构 `(id, content, metadata jsonb, embedding)`，列名可配但形状不可配；我们的 `org_id / kb_id / document_id / chunk_index` 是 NOT NULL 独立列，`addVectors` 不会写入，**插入会直接失败**
2. 查询形如 `SELECT *, col<=>$1 AS "_distance" ... LIMIT $2`，**没有 JOIN 钩子**，无法表达 `documents.status = 'ready'`，只能把状态冗余进 JSONB metadata 并在每次状态变化时回写，漏同步就会检索到半成品文档
3. 租户隔离从「数据库强约束列」降级为 `metadata->>'org_id'` 文本比较
4. 默认返回 pgvector 距离而非相似度，与现有 `1 - 距离` 阈值语义不一致；且不能复用现有 HNSW 索引
5. 需要新建表并把生产已有文档重新嵌入

采用方案：实现 `KbRetriever extends BaseRetriever`，内部保留现有 pgvector SQL。这仍然是 LangChain 体系（可作为 `Runnable` 接入 LCEL 链、可 `asRetriever` 语义一致），但隔离、状态过滤、阈值语义、索引、数据全部不变，**零迁移、零重新嵌入**。

### 2.2 编排：LCEL 显式链，不用 RetrievalQA

`langchain@1.5.19` 已移除 `RetrievalQA`，只有 `@langchain/classic` 里标了 deprecated 的旧实现。官方推荐显式 LCEL。我们还需要「引用编号 [1..n] 与片段一一对应」，因此先取回带 metadata 的文档、自己编号，再进 prompt——LCEL 正好匹配这个形状。

> 实现结果：`RetrievalQA` 确实没有引入，提示词也确实建成 `ChatPromptTemplate`；但没有组装出 LCEL 链对象（没有 `.pipe()` 的 `RagChain`），实际是 `buildRagMessages()` + `ChatModelService.stream()` 的命令式两步调用，理由见 §5.3。评审裁定该偏离可接受——它与本节下一句「先取回文档、自己编号、再进 prompt」本来就是同一个形状，且 §5.3.3 已把检索移出链。

### 2.3 TXT/MD 保留自研解码

`TextLoader` 只按 UTF-8 读文件，会丢掉现有的 GB18030 回退（中文老编码文档会变乱码，这是已修过的线上问题）。因此 TXT/MD 继续用 `TextParser.parseBuffer`（UTF-8 严格解码失败 → GB18030 回退 → 归一化），再把结果包成 LangChain `Document` 交给切分器。PDF/DOCX 用 `PDFLoader` / `DocxLoader`。

> 实现结果：与代码一致。`ParserService.load()` 的 TXT/MD 分支调用 `TextParser.parseBuffer()`（`ingestion/parsing/parser.service.ts:54-61`），PDF/DOCX 分别走 `PDFLoader` / `DocxLoader`（`:62-72`、`:110-175`），最后统一包成**单个** `Document`，`metadata.source` 存的是 storageKey 而不是文件名（`:77-87`）；e2e 里有一条 GB18030 用例专门钉住这条契约（`test/ingestion.e2e-spec.ts`）。

## 3. 依赖与版本约束

| 包 | 版本 | 说明 |
|---|---|---|
| `@langchain/core` | ^1.3.0 | Document、BaseRetriever、ChatPromptTemplate、Runnable |
| `@langchain/openai` | ^1.7.0 | ChatOpenAI、OpenAIEmbeddings（`engines.node >= 22`） |
| `@langchain/community` | ^1.1.29 | PDFLoader、DocxLoader |
| `@langchain/textsplitters` | ^1.0.2 | RecursiveCharacterTextSplitter（`langchain/text_splitter` 在 v1 已移除） |

已核实的事实与约束：

1. 四个包都是 CJS + ESM 双格式（`require` 条件指向 `.cjs`），我们的 NestJS CommonJS 构建可直接 `require`，不需要改 ESM
2. 生产镜像是 Node 22，满足 `@langchain/openai` 的 `>=22`；本地 Node 24 也满足
3. `PDFLoader` / `DocxLoader` 内部用 `await import('pdf-parse')` / `await import('mammoth')`，在 Jest CJS 下会报 "Failed to load pdf-parse"。现有测试脚本已经带 `--experimental-vm-modules`；`PDFLoader` 还支持注入自定义 importer（`new PDFLoader(p, { pdfjs: customImporter })`）作为兜底
4. `pdf-parse` peer 支持 `^1.0.0 || ^2.0.0`，我们已经是 v2（`PDFParse` 类），兼容
5. 流式：`model.streamEvents(messages, { signal })` → `stream.text` 是 `AsyncIterable<string>`，`signal` 会真正中止 HTTP 请求；中断后的部分文本需要自己累加保存（与现有「中断保留半条回答」行为一致）

## 4. 目标架构

```
上传 → pg-boss 队列 → IngestionService
                          ├─ 解析层：PDFLoader / DocxLoader / TextParser(自研解码) → Document[]（每份文件一个）
                          ├─ splitToChunks()（内部 RecursiveCharacterTextSplitter）→ string[]
                          │    大小取 CHUNK_SIZE / CHUNK_OVERLAP（默认 800 / 120），显式中文分隔符
                          ├─ EmbeddingsService.embed() → number[][]
                          │    每 16 条一批调 OpenAIEmbeddings.embedDocuments，并校验条数与维度
                          └─ 现有 SQL 事务写 chunks 表 + documents.status='ready' + pg_notify

提问 → ChatService.run（会话与持久化职责不变）
          ├─ new KbRetriever(retrieval, {orgId, kbId, signal}).invoke(question)
          │    → Document<Source>[] → toSource() → Source[]（一次问答只检索这一次）
          ├─ onMeta(sources) 先推引用 → buildRagMessages() → ChatModelService.stream() 逐 token onDelta
          └─ 中断：生成阶段把已生成部分落库并标 interrupted；检索阶段不落助手行
               两者都返回 interrupted:true ⇒ 前端收到 chat:done(cancelled:true)
```

模块映射（现状 → 目标）：

| 现有文件 | 目标 |
|---|---|
| `llm/llm.service.ts`（fetch + 手写 SSE） | 拆成 `llm/embeddings.service.ts`（OpenAIEmbeddings）+ `llm/chat-model.service.ts`（ChatOpenAI）；`sse-parser.ts` 删除 |
| `ingestion/parsing/parser.service.ts` | 改为产出 `Document[]`：PDF/DOCX 走 LangChain loader，TXT/MD 走自研解码后包 `Document` |
| `ingestion/parsing/pdf.parser.ts` / `docx.parser.ts` | 由 `PDFLoader` / `DocxLoader` 替代并删除 |
| `ingestion/parsing/chunker.ts` | 由 `RecursiveCharacterTextSplitter` 替代（参数等价），保留纯函数包装便于测试 |
| `chat/retrieval.service.ts` | 保留 SQL，新增 `chat/kb.retriever.ts` 作为 LangChain `BaseRetriever` 外壳 |
| `chat/prompt.service.ts` | 改为 `ChatPromptTemplate`（system + context + history + question），落地在 `chat/rag-prompt.ts`，`PromptService` 已删除；编号规则不变 |
| `chat/chat.service.ts` | 编排改为 `KbRetriever.invoke()` → `buildRagMessages()` → `ChatModelService.stream()` 三处命令式调用（没有 `RagChain` 对象，见 §5.3）；会话/权限/落库/WS 事件逻辑不动 |
| `llm/llm.errors.ts` | `LlmError` 保留（嵌入的条数/维度自检仍抛它）；「永久错误不重试」由 `IngestionService` 按 `BadRequestException` 判定（`ingestion.service.ts:141`），「可重试」交给 LangChain 客户端的 `maxRetries`（`llm.module.ts:88` 嵌入 3 次、`:106` 对话 1 次） |

## 5. 详细设计

### 5.1 模型层

`EmbeddingsService`：

1. 用 `configuration.baseURL` 指向 SiliconFlow，`model = EMBEDDING_MODEL`（bge-m3），`maxRetries = 3`，`timeout = 60s`
2. `embedDocuments(texts)` 内部按 16 条一批切分（保持现有批量上限，避免单次请求过大）
3. 返回后逐条校验维度必须等于 `config.embedding.dimensions`（1024），不一致抛 `LlmError`——这条校验必须保留，否则脏向量会写进 `vector(1024)` 列并在检索时才炸

`ChatModelService`：

1. `ChatOpenAI({ model, apiKey, configuration:{ baseURL }, temperature: 0.2, maxTokens: 1500 })`
2. 暴露 `stream(messages, signal): AsyncGenerator<string>`，内部用 `streamEvents(..., { signal })` 的 `stream.text`
3. 5 分钟总超时保留（LangChain 的 timeout 是单次请求超时，长回答需要外层兜底）

> 实现结果（对上列 `EmbeddingsService` 三条与 `ChatModelService` 三条的修正与补充，共 6 条）：
>
> 1. `EmbeddingsService` 第 2 条还有一道**条数**校验：每批返回的向量条数必须等于该批请求条数，否则抛 `LlmError('Embedding 返回数量不正确')`（`llm/embeddings.service.ts:102-104`）——条数错位是静默错误，片段与向量会对不上。批量上限 16 条是我们自设的常量（`:14`），不是 provider 给的。
> 2. 对话客户端额外设了 `maxRetries: 1`（`llm/llm.module.ts:106`），嵌入是 3 次（`:88`）。
> 3. `ChatOpenAI.streamEvents` 必须传 `version: 'v2'`，返回的是完整事件流（含链/工具的开始结束事件），不是纯文本增量；`llm.module.ts` 用 `ChatOpenAIAdapter` + `toTextDeltas()` 收敛成 `{ text }`，只保留 `on_chat_model_stream` 的增量。过滤时只判 `isBaseMessageChunk` 不判 `isAIMessageChunk`——provider 在首个增量省略 `delta.role` 时产出的是 `ChatMessageChunk`，按后者过滤会把整段回答丢成空串（`llm/llm.module.ts:31-46`）。
> 4. 第 3 条「5 分钟总超时」的准确说法：它是作为单次调用的 `options.timeout` 透传给底层 HTTP 请求的常量（`llm/chat-model.service.ts:16`、`:36-39`），不是外层端到端兜底；最坏耗时可能超过 5 分钟。
> 5. 嵌入这一侧的 `signal` **不能**取消 HTTP：`OpenAIEmbeddings@1.7` 的 `embedDocuments(texts)` 只接收文本数组（工作区根 `node_modules/@langchain/openai/dist/embeddings.d.ts:98`——本仓库是 npm workspace，`@langchain/openai` / `core` / `textsplitters` 提升到根 `node_modules`，只有 `@langchain/community` 在 `apps/api/node_modules`；`node_modules` 不上传服务器，这类指针只能在本地打开），会忽略我们传的 signal。`EmbeddingsService` 因此自己在外面做了两层——每批派发前检查 `signal.aborted`（`:93-95`）、等待时与 abort 竞争一次（`:44-64`）。效果是**调用方立刻解阻**，而已在飞的请求（含最多 3 次重试、单次 60s 超时）继续跑完、结果被丢弃。
> 6. 本节第 2 条那句「按 16 条一批」是**自设**常量（`llm/embeddings.service.ts:14`），不是 SDK 给的：`OpenAIEmbeddings` 的 `batchSize` 默认 512（`node_modules/@langchain/openai/dist/embeddings.js:28`，字段声明 `embeddings.d.ts:35`/`:67`），我们没有覆盖它，只是每次 `embedDocuments` 最多传 16 条，所以 SDK 内部不会再切一次。`llm/embeddings.service.ts:13` 注释里的「SDK 默认 batchSize 是 512」与源码一致。

### 5.2 解析与切分

1. `ParserService.load(storageKey): Promise<Document[]>`：按扩展名分派；PDF 用 `PDFLoader`（保留 200 页上限与 60s 超时的显式校验，loader 本身不管这些），DOCX 用 `DocxLoader`，TXT/MD 用自研解码后 `new Document({ pageContent, metadata: { source } })`
2. 归一化（`normalizeText`：去控制字符、统一换行、压缩空行）继续作用在文本上，放在 loader 之后、切分之前
3. `RecursiveCharacterTextSplitter({ chunkSize: 800, chunkOverlap: 120, lengthFunction: (s) => s.length, separators: ['\n\n', '\n', '。', '！', '？', '；', '，', ''] })`——中文文档没有空格，默认英文分隔符会把整段切成一块，必须显式给中文标点
4. 空内容仍然抛 `BadRequestException('文档内容为空')`，保证队列不把永久错误当可重试错误

> 实现结果（与代码对齐后的四条）：
>
> 1. PDF 分支多了一步前置探测：先用 `pdf-parse` 的 `PDFParse.getInfo()` 只读元数据拿页数（比整篇解析便宜得多），超限立即拒绝，之后才让 `PDFLoader` 去取正文（`ingestion/parsing/parser.service.ts:114-137`）。探测与正文各算一次 60s，不是整篇的总预算。页数上限 200、超时文案见 `ingestion/parsing/pdf-pages.ts:10-23`。`load()` 返回的数组恒为 1 个 `Document`，`metadata.source` 是 storageKey（`parser.service.ts:82-87`）。
> 2. 归一化确实在 loader 之后（`parser.service.ts:77`）；切分器内部还会再归一化一次（`chunker.ts:38`），PDF 页与页之间用两个换行拼接以保住段落边界（`parser.service.ts:139`）。
> 3. 分隔符最终是 `['\n\n', '\n', '。', '！', '？', '；', '，', '、', ' ', '']`（比原设计多一个顿号与空格一档，`chunker.ts:15`）；`chunkSize`/`chunkOverlap` 由配置注入并夹到合法区间（`Math.max(1, size)`、`min(overlap, size - 1)`，`chunker.ts:42-47`），非法配置在启动阶段就被拒（见 §7）。重叠是「尽力而为」，短片段场景实际重叠可能为 0（`chunker.ts:21-25`）。
> 4. 空内容契约按格式分开，不再是一个全局长度闸口：TXT/MD 在解码层抛 `文档内容为空`（`text.parser.ts:66-68`）；PDF 归一化后短于 20 字符按扫描件抛 `PDF 未包含可提取文本，可能是扫描件`（`parser.service.ts:142-144`）；DOCX 只拒绝空内容，抛 `DOCX 未包含可提取文本`（`:165-167`）；loader 静默返回空串由 `load()` 兜底抛 `文档未包含可提取文本`（`:79-81`）。**20 字符下限只作用于 PDF**——评审指出原设计的统一闸口会让 10 个字的 TXT/MD/DOCX 从 ready 变 failed，违背目标 2，故收窄。全部 400 都由 `IngestionService` 判成永久失败。

### 5.3 检索与链

1. `KbRetriever._getRelevantDocuments(query)` 调用现有 `RetrievalService.retrieve(orgId, kbId, query, signal)`，返回带 metadata 的 `Document[]`；`orgId/kbId/signal` 在构造时绑定（每次请求 new 一个），避免跨请求串租户
2. 相似度分数与阈值过滤留在 SQL 层（`1 - 距离 >= retrievalMinScore`），LangChain 侧不再二次过滤
3. **检索只发生一次**：`ChatService` 先调用 `KbRetriever` 拿到 `Source[]`（用于 `onMeta` 与消息落库），再把「已检索好的文档」作为输入交给下游链 `prompt → model`。链内部不再触发第二次检索，避免重复嵌入调用与引用编号错位
4. `RagChain` 用 LCEL 组装：`ChatPromptTemplate`（system + 编号上下文 + history + question）→ `ChatOpenAI`；编号上下文由 `formatNumberedContext(sources)` 生成，输出 `[i] 文件：xxx（片段 n）\n内容`，与现有 prompt 完全一致
5. `ChatService` 仍然：先 `onMeta`（引用先到前端）→ 再逐 token `onDelta` → 中断时把已生成部分落库并标记 `interrupted`

> 实现结果：第 1、5 条按原样落地；第 2 条只有一半成立——「LangChain 侧不再二次过滤」是真的（`KbRetriever._getRelevantDocuments` 只做 `Source → Document` 包装，`chat/kb.retriever.ts:58-74`），但「阈值过滤留在 SQL 层」不是：SQL 只把分数算出来（`1 - (c.embedding <=> $1::vector) AS score`，`chat/retrieval.service.ts:73-79`），`>= retrievalMinScore` 的过滤与 1..n 引用编号都在 JS 里（`chat/retrieval.service.ts:88-100`，运维口径见 `docs/operations.md` §11.5）。第 2 条原文保留不动（那是设计时的打算），实现不是那个形状；第 3 条「只检索一次、同一份 `Source[]` 既用于 `onMeta` 又用于落库与提示词」也落地了，但它下游接的不是「链」而是命令式的两步；第 4 条的 `RagChain` **没有建出来**。下面是最终形状。
>
> - 实际调用序列是命令式的三步，在 `ChatService.run()` 里一次走完（`chat/chat.service.ts:171-231`）：
>   1. `new KbRetriever(this.retrieval, { orgId, kbId, signal })` → `await retriever.invoke(question)` → `documents.map(toSource)` 得到 `Source[]`（`:173-186`）
>   2. `params.onMeta({ conversationId, userMessageId, sources })`（`:199-203`）；`sources` 为空则回固定话术并直接落库、不打模型（`:206-222`）
>   3. `const prompt = await buildRagMessages(history, sources, question)` → `for await (const delta of this.chatModel.stream(prompt, signal))`，逐段 `onDelta` 并累加 `answer`（`:225-231`）
> - `buildRagMessages()` 在 `chat/rag-prompt.ts`：模块级 `ChatPromptTemplate.fromMessages([['system', ...{context}], new MessagesPlaceholder('history'), ['human', '{question}']])`（`:35-39`），用 `formatMessages()` 渲染（core 1.x 的 `format()` 返回字符串、拿不回 role，`:85-87`），再映射回 `{ role, content }`。`formatNumberedContext()` 输出 `[i] 文件：xxx（片段 n）\n内容`，与已删除的 `PromptService` 逐字节一致，`chat/rag-prompt.spec.ts` 用整串相等断言钉住。
> - 为什么不用 `.pipe()` 组链：真正构成约束的只有 (a)(b) 两条。(a) `meta` 必须先于第一个 `delta` 到前端，引用卡片才不会掉到回答后面——而单向数据流的链里没有一个「生成开始前」的输出位置，硬要保序就得往链里塞一个带副作用的 `RunnableLambda`、或改用 `streamEvents` 的回调去推 `meta`，等于把命令式代码搬进声明式外壳；(b) 检索只能发生一次，链内部若再挂 retriever 会多打一次嵌入并让引用编号与提示词编号错位（本条第 3 点本身已把检索移出链）。(c) 不是表达力问题：中断时要把**已生成的半条**累加落库并标 `interrupted`，靠的是 `ChatService.run()` 自己持有的可变累加器与 try/catch（`chat/chat.service.ts:226-252`），这一段无论组不组链都位于链外——即使把生成部分包成 `prompt | model`，逐段消费、累加与异常收尾仍然写在调用方。所以最后是按成本收益定的：组链只把 `buildRagMessages` → `stream` 这一跳换成 `.invoke()`，却要为 (a) 额外引入副作用节点，收益抵不过成本。B7 评审裁定该偏离可接受。
> - 一个容易踩的框架细节：`BaseRetriever.invoke()` 在 `@langchain/core` 1.3 里只跑 callbacks + `_getRelevantDocuments`，**不读** `RunnableConfig.signal`，所以取消只能来自构造时绑定的 `options.signal`（`chat/kb.retriever.ts:50-56`）。
> - `Document` 的泛型是 `Document<Source>`，`toSource()` 同样按 `Source` 取字段：键名写错会在 tsc 阶段炸掉，不会静默把 `undefined` 落进 `messages.sources`（`chat/sources.ts:32-43`）。

### 5.4 错误处理

1. 嵌入/对话的可重试错误（429、5xx、网络）交给 LangChain `maxRetries` + 指数退避
2. 400 类内容错误必须保持「终态失败、不消耗队列重试」的现有语义：`IngestionService` 仍按 `BadRequestException` 判定
3. 检索阶段异常向上传播为 `chat:error`，不落半条回答（与现状一致）

> 实现结果（第 3 条需修正）：检索阶段的**用户取消**不再上抛。`run()` 用与生成阶段同一个 `isAbort()` 判据（`chat/chat.service.ts:65-67`）把取消收敛成 `{ interrupted: true, answer: '', sources: [], assistantMessageId: null }` 的正常返回——此刻还没有可落库的内容，于是不落助手行、也不推 `chat:meta`，网关仍推一条 `chat:done(cancelled:true)`（`realtime/realtime.gateway.ts:379-384`）。修复前它会抛到网关的 catch，那里见 `signal.aborted` 就既不发 error 也不发 done，前端气泡永久停在「生成中」。非取消的检索失败（`LlmError`、数据库故障）照旧上抛并转成 `chat:error`。

## 6. 测试策略

1. 单元测试：`chunker.spec.ts` 改为断言 splitter 的等价行为（块数、重叠、中文标点切分）；`parsers.spec.ts` 改为断言 loader 产出 `Document[]`；`sse-parser.spec.ts` 随文件删除
2. 集成测试用 LangChain 官方假实现（`FakeListChatModel`、`FakeEmbeddings`）注入，e2e 不打真实 SiliconFlow API，避免 CI 依赖外部服务与费用
3. 现有 24 个 e2e 必须全绿，特别是 `ingestion.e2e-spec.ts`（含片段展开接口）与 `conversations.e2e-spec.ts`
4. 新增一条 e2e：上传 GB18030 编码的 TXT，断言不乱码——防止将来有人把 TXT 也换成 `TextLoader`
5. 全量类型检查 + 构建 + 前端测试（前端不改，作为回归哨兵）

> 实现结果（第 2、3 条修正）：测试注入的不是 LangChain 官方假实现（`FakeEmbeddings` / `FakeListChatModel` 全仓零引用），而是自写的假 provider，用 `overrideProvider(EMBEDDINGS_PROVIDER)` / `CHAT_MODEL_PROVIDER` 换掉工厂产物（`test/ingestion.e2e-spec.ts:64-77`、`test/realtime.e2e-spec.ts`）——因为服务面向的是 `llm/llm.tokens.ts` 里那两个最小接口，换掉 provider 就够，不需要假 LangChain 对象。e2e 规模从设计时的 24 条涨到 **9 个 suite / 30 条**（迁移期间新增 GB18030、可重试故障、片段展开等用例），前端仍是 9 条。

## 7. 部署与运维影响

1. 依赖树变大：`node_modules` 与镜像层增长，`npm ci` 时间变长；ECS 只有 1.8GB 内存，构建仍需串行、镜像层需保持 `node:22-bookworm-slim`
2. Worker 与 API 共用同一镜像，LangChain 依赖会同时进入 worker（解析本来就在 worker 跑，合理）
3. 回滚方式：保留上一版镜像 tag，异常时 `docker compose up -d --no-deps api worker` 指回旧 tag；数据库无变更，因此回滚不涉及数据
4. 分阶段落地：新链路与旧链路并存到切换点（配置开关不是目标，直接分两步提交：先加新模块 + 测试，再删旧实现），避免半成品状态

> 实现结果（第 1、3 条修正）：
>
> 1. 第 1 条按预期发生：服务器上 `knowledge-rag-api:local` 现为 902MB（2026-10-23 部署后实测），构建仍串行、基础镜像仍是 `node:22-bookworm-slim`。
> 2. 第 3 条的「保留上一版镜像 tag」没有成立：compose 把 api/worker/web 的镜像名写死成 `knowledge-rag-api:local` / `knowledge-rag-web:local`（`deploy/docker-compose.yml:5/13/40/55`），重建只会把 tag 挪到新镜像，旧构建变成**无 tag 的悬空镜像**，`docker images` 里认不出哪个是上一版。因此本次真正的回滚手段是从 **LangChain 回滚基线 `a45e432`**（B 系列之前的最后一个提交）同步代码后重建 api（worker 共用同一镜像），并按 `deploy/DEPLOY.md` §2.1 核对删除项。回滚到 `a45e432` 丢的是 B1–B8 的链路改造（以及其后的 C1 注释、C2 文档），保住 BUG-1 `c4d5ea4`（按 userId 加 KB 成员时的组织归属校验）与 BUG-2 `a45e432`（切知识库重置会话状态）两个修复；迁移前基线 `013b9cc` 在这两个修复**之前**，退回那里等于撤掉 `c4d5ea4` 的组织归属校验：外组织的 userId 又能被直接写进 `knowledge_base_members`（不存在的 id 退回 500）。危害边界要按代码说准——`KbAccessService.resolve` 的判定 0b（`knowledge-bases/kb-access.service.ts:70-71`）仍然挡住实际访问，所以那不是「立刻越权」，而是污染授权表与成员列表，并在这个人之后加入本组织时立刻生效；因此 `013b9cc` 不是可用目标。数据库确实无变更，两种回滚都不涉及数据。今后部署前要先给旧镜像打版本 tag——步骤见 `deploy/DEPLOY.md` §10。
> 3. 原设计没预见、但确实成为部署前置条件的一条：B5 加的切分配置启动校验会让「曾经能用但配错」的 `.env` 直接把 api 与 worker 拒在启动阶段（`config/config.service.ts:26-69`，`app.module.ts:32` 与 `worker.module.ts:22` 都装了 `AppConfigModule`）。核对步骤写在 `deploy/DEPLOY.md` §1.1 与 `docs/operations.md` §11.4。

## 8. 风险清单

| 风险 | 影响 | 处置 |
|---|---|---|
| `PDFLoader` 动态 import 在 Jest 下失败 | 测试挂 | 已有 `--experimental-vm-modules`；必要时注入自定义 `pdfjs` importer |
| 中文切分退化（默认分隔符按空格切） | 检索质量下降 | 显式中文 separators + 单测断言块数与重叠 |
| 流式语义差异（`streamEvents` 与手写 SSE 的增量粒度） | 前端渲染抖动或重复 | e2e 断言 delta 拼接结果与落库内容一致 |
| 依赖体积导致 ECS 构建 OOM | 部署失败 | 串行构建、保留 swap 检查、构建前确认内存 |
| 半条回答持久化行为漂移 | 用户中断后内容丢失 | 保留原 catch 分支并加 e2e 覆盖 |

## 9. 注释规范（与本次重写一并执行）

1. 所有新增/重写文件按已确认样式写中文注释：文件头说明职责与边界，函数说明「做什么 + 步骤 1/2/3」，关键行前加定位注释
2. 存量代码全量补齐：后端 100 个非测试源文件、前端 51 个、测试 21 个；按模块分批，每批跑类型检查与测试确保逻辑零改动
3. 顺序：先做不受 LangChain 影响的部分（前端全部 + 后端 auth/organizations/knowledge-bases/documents/queue/realtime/common/config/database），最后做会被重写的 `llm`/`ingestion`/`chat` 模块，避免给要删的代码补注释

> 实现结果：第 3 条的顺序按原样执行了（Phase A 先注存量、Phase B 再重写 `llm`/`ingestion`/`chat`、Phase C1 注测试）。第 2 条的文件数是迁移前清点出来的估数，别当准数用——2026-10-23 实测 `apps/api/src` 非测试 `.ts` 为 101 个、`apps/web/src` 非测试 `.ts/.tsx` 为 51 个，链路重写本身会增删文件，注释覆盖范围以各批次的完成记录为准。
