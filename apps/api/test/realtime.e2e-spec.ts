/**
 * WebSocket 协议 e2e：整套里唯一跑「真 socket.io 握手 + 真 HTTP 监听」的用例，守两件事——
 * WS 协议的形状，以及「WS 侧的鉴权与 HTTP 侧是两套独立实现」这条容易被人误当成一体的前提。
 * 为什么必须做成端到端（而不是像 chat.service.spec 那样编排假依赖）：
 * WebSocket 不进 Nest 的中间件与 APP_GUARD 链，cookie-parser / OriginGuard / AuthGuard /
 * ThrottlerGuard / 全局异常过滤器在这里【一个都不生效】（见 realtime.gateway.ts 文件头「最重要的一条前提」段）。
 * 身份、跨站、限流、错误兜底四件事全在网关里重写了一遍，重写错了 HTTP 侧再对也照样泄露。
 * 协议形状（本文件断言到的部分，逐条对上网关代码）：
 * - 握手：server.use 里先比 Origin 再解 Cookie 里的 kr_session，任一步失败统一
 *   next(new Error('unauthorized'))（gateway 的 #afterInit 握手中间件）——客户端只会看到连接失败
 * - kb:join 用 emitWithAck，成功 {ok:true, permission}，任何失败塌成 {ok:false}（#join）
 * - chat:send 之后是 meta / delta* / done 三段，出错才发 chat:error（#chatSend）；
 *   跨组织问答在 run() 之前就被网关的 kbAccess.require 拒掉，发的是准入那一句文案
 *   （#chatSend 的第 6 步，本文件最后一条用例专门钉「在哪一层拦的」）
 * - done 的 cancelled 来自 ChatResult.interrupted（#chatSend 的第 9 步），前端只在这样的 done 上退出流式态；
 *   中断收尾自己失败时兜底的那条 done（assistantMessageId 为 null）是第 10b 步，本文件的取消用例测不到它，
 *   由 realtime.gateway.spec.ts 钉
 * - document:status 的来源是 worker 的 pg_notify('kr_document_status')，
 *   由本进程第二条独立 PG 连接 LISTEN 后转交网关（realtime.listener.ts:96-100）
 * - kb:access-revoked 走【进程内】内存总线，不经过数据库（#afterInit 的步骤 3）
 * 两个 provider 都被替换（EMBEDDINGS_PROVIDER / CHAT_MODEL_PROVIDER），所以没有任何请求打向模型服务；
 * 但检索是真跑 SQL 的（KbRetriever → RetrievalService 的 pgvector 查询），
 * 于是「SQL 里的 org_id/kb_id 隔离条件真的生效过、并且取回分数之后 JS 侧那道阈值过滤确实放行过片段」
 * 这件事在 e2e 里有两处经过（注意分工：SQL 只算 `1 - 余弦距离` 与 Top-K，
 * 阈值比较与引用编号都在 retrieval.service.ts:88-100 的 JS 里）：
 * 这里是「问答编排里带着引用落库」的那条链路，ingestion.e2e-spec.ts 那处是直接调 retrieve；
 * 单测侧则全是假 retrieve（见 task-16a 报告 Concerns 第 4 条：RetrievalService 没有单测），
 * 所以 WHERE 条件被改坏时，只有这两个 e2e 文件会红
 * 环境与顺序（改动前必读）：
 * - 必须 app.listen(0) 拿到随机端口，socket.io 客户端要真连接；
 *   beforeAll 里那次 Promise.race 等的是 RealtimeListenerService.ready——
 *   pg_notify 不持久化不补发，LISTEN 没挂上就发通知，这条用例会以 5 秒超时红
 *   （ready 目前在生产路径没人等，只有这里等，见 realtime.listener.ts:34-46）
 * - embedControl 是【全 suite 共享】的慢嵌入开关，用完必须关掉，见它自己的注释
 * - 用例各自新建组织与库，无 truncate，彼此不依赖；但每条用例内部的
 *   「先等 provider 进入 → 再发 cancel」是真时序依赖，把它改成并发或提前就会测不到检索窗口
 * - 有资料那条用 raw SQL 播种 documents/chunks，而不是走上传接口：
 *   API 进程没有 consumer，上传后文档永远停在 queued，而检索的 WHERE 只认 status='ready'
 *   （retrieval.service.ts:77），走 HTTP 得手动改状态、还得造一份磁盘文件；直接插两行更短也更明确。
 *   代价：storage_key 'rt/1' 在磁盘上并不存在，所以这条用例【没有】经过文件层，只测召回
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'node:crypto';
import { io, Socket } from 'socket.io-client';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';
import {
  CHAT_MODEL_PROVIDER,
  EMBEDDINGS_PROVIDER,
} from '../src/llm/llm.tokens';
import { AccessEventsService } from '../src/common/events/access-events.service';
import { RealtimeListenerService } from '../src/realtime/realtime.listener';
import { NO_RESULTS_ANSWER } from '../src/chat/chat.service';

/** 与 test/setup-env.ts:3 的 APP_ORIGIN 必须一致：握手期的 Origin 比对拿的就是这个值 */
const ORIGIN = 'http://localhost:5173';

/**
 * 假嵌入 provider 的「慢嵌入」开关，只服务于下面那条「检索期间取消」的用例。
 * 为什么要开关而不是把整套 provider 都改慢：这个 overrideProvider 是全 suite 共享的，
 * 无条件拖慢会让每条用例都白等，而取消必须精确落在「嵌入已在飞、还没返回向量」这个窗口里，
 * 否则测的就是生成阶段的取消了。
 * - delayMs：embedDocuments 拿到请求后挂起多久再返回假向量
 * - started：每次进入 embedDocuments 时回调一次，让测试能等到「请求确实在飞」那一刻再发 cancel
 */
const embedControl: { delayMs: number; started?: () => void } = { delayMs: 0 };

/**
 * 等一条 socket 事件并取第一个到达的载荷，超时则 reject。
 * 为什么不用 socket.io 自带的 once+无超时：事件顺序与数量正是被测对象，
 * 服务端漏发一条 done 的话，没有超时的写法会让整个 jest 进程挂死而不是给出可读失败。
 * 只取【第一个】到达的载荷：meta/done 按协议各只有一条，多余的重复本文件不去断言，
 * 「meta 一定先于 delta 到达」这条顺序同样没有断言（delta 是用 socket.on 另收的，两者无时序比较）
 */
function waitForEvent<T>(socket: Socket, event: string, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event);
      reject(new Error(`timeout waiting for ${event}`));
    }, timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/**
 * 用纯 websocket 传输连一次（刻意关掉 polling 升级与 reconnection）：
 * - 关掉 reconnection 是为了让「握手被拒」老老实实变成一次 connect_error，
 *   而不是客户端在后台无限重试、把失败拖成 5 秒超时
 * - Cookie 与 Origin 都是手工塞进握手头：这两样正是握手期中间件读的全部输入，
 *   用真浏览器才有自动携带，测试只能自己拼
 */
function connectSocket(port: number, cookie?: string): Promise<Socket> {
  const socket = io(`http://127.0.0.1:${port}`, {
    transports: ['websocket'],
    reconnection: false,
    extraHeaders: {
      Origin: ORIGIN,
      ...(cookie ? { Cookie: cookie } : {}),
    },
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('connect timeout'));
    }, 5000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timer);
      socket.close();
      reject(error);
    });
  });
}

/**
 * 从 HTTP 响应头里取会话 Cookie 的「名=值」那一段（丢掉 Path/HttpOnly 等属性）。
 * 只取 header[0]：本系统只写 kr_session 这一条 Cookie（auth.controller.ts:46-54 是唯一写入口），
 * 若将来多出第二条 Set-Cookie，这里会静默取错——不是断言，只是现状
 */
function cookieFrom(response: request.Response): string {
  const header = response.headers['set-cookie'];
  const value = Array.isArray(header) ? header[0] : header;
  return value.split(';')[0];
}

describe('realtime', () => {
  let app: INestApplication;
  let port: number;
  let db: DatabaseService;
  let revocations: AccessEventsService;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      // 检索的问题向量走 EmbeddingsService -> EMBEDDINGS_PROVIDER（1024 维假向量，不发网络请求）
      // 慢不慢由 embedControl 决定：默认 delayMs=0，即与改造前行为一致的快路径
      .overrideProvider(EMBEDDINGS_PROVIDER)
      .useValue({
        embedDocuments: async (texts: string[]) => {
          // 先报告「请求已经在飞」，再按开关挂起：给「检索期间取消」那条用例卡时序用
          embedControl.started?.();
          if (embedControl.delayMs) {
            await new Promise((resolve) =>
              setTimeout(resolve, embedControl.delayMs),
            );
          }
          return texts.map(() => Array(1024).fill(0.01));
        },
      })
      // 生成走 ChatModelService -> CHAT_MODEL_PROVIDER：适配器约定是 streamEvents
      // 返回 { text: 文本增量的异步可迭代对象 }，假实现只需满足这一个形状
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
      .compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    await app.listen(0);
    const address = app.getHttpServer().address();
    port = typeof address === 'object' && address ? address.port : 0;
    db = app.get(DatabaseService);
    revocations = app.get(AccessEventsService);
    await Promise.race([
      app.get(RealtimeListenerService).ready,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('listener not ready')), 5000),
      ),
    ]);
  });
  afterAll(() => app.close());

  /** 一套独立租户；cookie 是手工从 Set-Cookie 头里剥出来的，因为 socket 握手不经过 supertest 的 agent */
  const createWorkspace = async (suffix: string) => {
    const register = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({
        name: 'Owner',
        email: `rt-${suffix}-${Date.now()}@test.local`,
        password: 'password123',
        orgName: `RT ${suffix}`,
      })
      .expect(201);
    const cookie = cookieFrom(register);
    const orgId = register.body.organizations[0].id as string;
    const kb = await request(app.getHttpServer())
      .post(`/api/orgs/${orgId}/knowledge-bases`)
      .set('Cookie', cookie)
      .send({ name: 'Realtime KB', accessMode: 'org' })
      .expect(201);
    return {
      cookie,
      orgId,
      kbId: kb.body.id as string,
      userId: register.body.user.id as string,
    };
  };

  // 回归点：握手期没有 Cookie 就连不上——挡的是「把 WS 当成免鉴权通道」这种改法
  // （摘掉 server.use 里那次 sessions.verify，gateway 的 #afterInit 步骤 2b/2c）。
  // 断言用的是 rejects.toThrow() 这种弱形式，只证明「连接被拒」，不区分被拒原因是缺 Cookie
  // 还是 Origin 不对——对外本来就统一成 unauthorized（#afterInit 的 catch），所以这不是遗漏而是形状
  it('rejects sockets without a session', async () => {
    await expect(connectSocket(port)).rejects.toThrow();
  });

  // 回归点：kb:join 的 ack 形状（{ok:true, permission}）+ 「空库」这条分支的协议收尾。
  // ack 里的 permission 期望 manager：请求者既是组织 owner（判定 1 先命中，kb-access.service.ts:72）
  // 又是这个库的创建者（判定 2，:74），两条规则给同一个值，本用例区分不出来
  // 无资料时不发 chat:error、只推一条固定话术的 delta 再发 done(cancelled:false)，
  // 这条契约出自 chat.service.ts#run 的空结果分支（!sources.length）：不消耗模型调用，也不落 interrupted 行
  it('joins an authorized KB room and streams a no-source answer', async () => {
    const workspace = await createWorkspace('a');
    const socket = await connectSocket(port, workspace.cookie);
    try {
      const ack = await socket.timeout(5000).emitWithAck('kb:join', {
        orgId: workspace.orgId,
        kbId: workspace.kbId,
      });
      expect(ack).toMatchObject({ ok: true, permission: 'manager' });

      const metaPromise = waitForEvent<{
        requestId: string;
        sources: unknown[];
      }>(socket, 'chat:meta');
      const deltaPromise = waitForEvent<{ text: string }>(socket, 'chat:delta');
      const donePromise = waitForEvent<{
        assistantMessageId: string;
        cancelled: boolean;
      }>(socket, 'chat:done');

      socket.emit('chat:send', {
        orgId: workspace.orgId,
        kbId: workspace.kbId,
        question: '没有资料时怎么回答？',
        requestId: 'r1',
      });

      const [meta, delta, done] = await Promise.all([
        metaPromise,
        deltaPromise,
        donePromise,
      ]);
      expect(meta.sources).toEqual([]);
      expect(delta.text).toBe(NO_RESULTS_ANSWER);
      expect(done.cancelled).toBe(false);
      expect(done.assistantMessageId).toBeTruthy();
    } finally {
      socket.close();
    }
  });

  /**
   * 有资料时的完整链路：真库检索（KbRetriever）→ 提示链 → 假模型流（CHAT_MODEL_PROVIDER）。
   * 这个用例是上面那两个 provider 覆盖「真的被走到」的唯一证据：没有它，
   * CHAT_MODEL_PROVIDER 的假实现只是死配置，生成阶段断了也不会在这里暴露。
   */
  it('streams a cited answer and persists it when the KB has material', async () => {
    const workspace = await createWorkspace('d');
    // 片段向量每个分量都取 0.01，与假 embedDocuments 给问题的向量同向：
    // 余弦距离 0 -> 相似度 1，必然通过阈值，不依赖模型也不依赖真实嵌入
    const vector = `[${Array(1024)
      .fill(0.01)
      .join(',')}]`;
    const documentId = randomUUID();
    await db.query(
      `INSERT INTO documents (id, org_id, kb_id, uploaded_by, filename, mime_type,
                              size_bytes, storage_key, status, chunk_count)
       VALUES ($1, $2, $3, $4, '手册.md', 'text/markdown', 20, 'rt/1', 'ready', 1)`,
      [documentId, workspace.orgId, workspace.kbId, workspace.userId],
    );
    await db.query(
      `INSERT INTO chunks (id, org_id, kb_id, document_id, chunk_index, content, embedding)
       VALUES ($1, $2, $3, $4, 0, '发布代号是 Atlas', $5::vector)`,
      [randomUUID(), workspace.orgId, workspace.kbId, documentId, vector],
    );

    const socket = await connectSocket(port, workspace.cookie);
    try {
      await socket.timeout(5000).emitWithAck('kb:join', {
        orgId: workspace.orgId,
        kbId: workspace.kbId,
      });

      const deltas: string[] = [];
      socket.on('chat:delta', (payload: { text: string }) =>
        deltas.push(payload.text),
      );
      const metaPromise = waitForEvent<{
        conversationId: string;
        sources: { index: number; filename: string; chunkIndex: number }[];
      }>(socket, 'chat:meta');
      const donePromise = waitForEvent<{
        assistantMessageId: string;
        cancelled: boolean;
      }>(socket, 'chat:done');

      socket.emit('chat:send', {
        orgId: workspace.orgId,
        kbId: workspace.kbId,
        question: '发布代号是什么？',
        requestId: 'r2',
      });

      const [meta, done] = await Promise.all([metaPromise, donePromise]);
      expect(meta.sources).toHaveLength(1);
      expect(meta.sources[0]).toMatchObject({
        index: 1,
        filename: '手册.md',
        chunkIndex: 0,
      });
      expect(deltas).toEqual(['回答', '内容']);
      expect(done.cancelled).toBe(false);
      expect(done.assistantMessageId).toBeTruthy();

      // 引用编号要能在落库的 sources 里对上，前端回放才画得出同样的卡片
      const rows = await db.query<{
        role: string;
        content: string;
        sources: { index: number; documentId: string }[];
        interrupted: boolean;
      }>(
        `SELECT role, content, sources, interrupted FROM messages
         WHERE conversation_id = $1 ORDER BY created_at, id`,
        [meta.conversationId],
      );
      expect(rows.rows.map((row) => row.role)).toEqual(['user', 'assistant']);
      expect(rows.rows[1].content).toBe('回答内容');
      expect(rows.rows[1].interrupted).toBe(false);
      expect(rows.rows[1].sources[0]).toMatchObject({
        index: 1,
        documentId,
      });
    } finally {
      socket.close();
    }
  });

  /**
   * 取消落在「检索期间」的端到端收尾（回归证明）。
   * 步骤：
   * 1. 打开慢嵌入开关（2 秒），provider 一进入就回调 started 报告「请求已在飞」
   * 2. 发 chat:send，等 started 之后才发 chat:cancel ⇒ abort 必然命中嵌入等待窗口，
   *    而不是生成阶段（生成阶段的取消另有单测覆盖）
   * 3. 断言客户端收到 cancelled=true 的 chat:done：前端 ChatPage 只在这样的 done 上退出流式态，
   *    少了这条事件气泡就永远转圈（13b 的派发前闸门让这条路径从「慢」变成「彻底不结束」）
   * 4. 断言没有 chat:error（用户主动停止不是故障）也没有助手行（一个字都没生成）
   * 为什么必须做成端到端：单测里 ChatService 的返回值是被直接断言的，只有走真网关才能证明
   * 「chat.run 正常返回 ⇒ 真的 emit 了一条 done」这一环，也就是评审说的那个缺口的另一半。
   */
  it('emits a cancelled chat:done when the user cancels during retrieval', async () => {
    const workspace = await createWorkspace('e');
    const socket = await connectSocket(port, workspace.cookie);
    try {
      await socket.timeout(5000).emitWithAck('kb:join', {
        orgId: workspace.orgId,
        kbId: workspace.kbId,
      });

      const errors: unknown[] = [];
      socket.on('chat:error', (payload: unknown) => errors.push(payload));

      const embeddingsInFlight = new Promise<void>((resolve) => {
        embedControl.started = () => resolve();
      });
      // 2 秒远大于 abort 的往返（同一条 socket，毫秒级），又不至于拖慢整套 e2e
      embedControl.delayMs = 2000;

      const donePromise = waitForEvent<{
        conversationId: string;
        assistantMessageId: string | null;
        cancelled: boolean;
      }>(socket, 'chat:done');

      socket.emit('chat:send', {
        orgId: workspace.orgId,
        kbId: workspace.kbId,
        question: '嵌入还没返回时点停止会怎样？',
        requestId: 'r3',
      });

      await embeddingsInFlight;
      socket.emit('chat:cancel', { requestId: 'r3' });

      const done = await donePromise;
      expect(done.cancelled).toBe(true);
      expect(done.assistantMessageId).toBeNull();
      expect(errors).toEqual([]);

      // 检索期间取消 ⇒ 只落了用户那一行；没有半条回答可保存，也没有 interrupted 的助手行
      const rows = await db.query<{ role: string }>(
        `SELECT role FROM messages WHERE conversation_id = $1 ORDER BY created_at, id`,
        [done.conversationId],
      );
      expect(rows.rows.map((row) => row.role)).toEqual(['user']);
    } finally {
      // 关掉开关，否则后面的用例都会白等 2 秒（started 也一并清掉，避免残留回调）
      embedControl.delayMs = 0;
      embedControl.started = undefined;
      socket.close();
    }
  });

  // 一条用例装了三件事，各钉一个回归点，顺序不能重排（后两段都依赖第二段成功 join 的那个房间）：
  // 1) 跨组织的 kb:join 只回 {ok:false}：拦点是 resolve 的判定 0b
  //    （second 不是 first 组织的成员，kb-access.service.ts:70-71），
  //    与 HTTP 侧同口径——socket 层不承认「这个 kbId 在别的组织里真实存在」
  // 2) document:status 端到端可见：自己 pg_notify → 本进程那条独立 LISTEN 连接 → 网关广播。
  //    载荷是【手工照抄】ingestion.service.ts:176-187 的字段拼法，不是真由入库发出来的，
  //    所以这里证明的是「通道 + 房间裁剪」，字段名两侧改一边（notify 或本文件）都测不出来；
  //    断言也只看 documentId/status 两个字段，网关那层「orgId 与 uploadedBy 不出门」的
  //    字段白名单（realtime.gateway.ts#broadcastDocumentStatus 的组装 event 那段）没有任何断言在守
  // 3) kb:access-revoked：直接调进程内总线 emit，绕过了 members.remove / kbMembers.remove
  //    那些真实触发点（触发侧的覆盖在 knowledge-bases.e2e-spec.ts，但它没订阅 socket），
  //    所以这条测的是「总线事件 → 退房间 + 推通知」这后半段，reason 字段也没有断言
  it('blocks cross-org joins and delivers document status and revocation events', async () => {
    const first = await createWorkspace('b');
    const second = await createWorkspace('c');
    const socket = await connectSocket(port, second.cookie);
    try {
      const denied = await socket.timeout(5000).emitWithAck('kb:join', {
        orgId: first.orgId,
        kbId: first.kbId,
      });
      expect(denied).toEqual({ ok: false });

      const allowed = await socket.timeout(5000).emitWithAck('kb:join', {
        orgId: second.orgId,
        kbId: second.kbId,
      });
      expect(allowed.ok).toBe(true);

      const statusPromise = waitForEvent<{
        documentId: string;
        status: string;
      }>(socket, 'document:status');
      const documentId = randomUUID();
      await db.query('SELECT pg_notify($1, $2)', [
        'kr_document_status',
        JSON.stringify({
          documentId,
          orgId: second.orgId,
          kbId: second.kbId,
          uploadedBy: second.userId,
          status: 'ready',
          chunkCount: 1,
          error: null,
        }),
      ]);
      const status = await statusPromise;
      expect(status.documentId).toBe(documentId);
      expect(status.status).toBe('ready');

      const revokedPromise = waitForEvent<{ kbId: string }>(
        socket,
        'kb:access-revoked',
      );
      revocations.emit({
        userIds: [second.userId],
        kbId: second.kbId,
        reason: 'kb-member-removed',
      });
      const revoked = await revokedPromise;
      expect(revoked.kbId).toBe(second.kbId);
    } finally {
      socket.close();
    }
  });

  /**
   * 跨组织的 chat:send 必须被拒（评审 Minor #16 补的执法点端到端用例）。
   * 为什么要单独一条：realtime.gateway.ts#chatSend 第 6 步那次 kbAccess.require 是 WS 侧唯一拦住
   * 「拿数据」的地方（房间归属不是资格、kb:leave 与 chat:cancel 也不判权），
   * 而它此前只有单测——那些测的是 KbAccessService.resolve 的判定顺序，
   * 没有任何用例真的从 socket 发一次 chat:send，把「网关在 run 之前就拦」这一层钉住。
   * 步骤：
   * 1. owner 建自己的库；intruder 是另一个组织的注册者，对该库既不是成员也没有授权（判定 0b）
   * 2. intruder 带【自己的】会话连上 socket，直接朝 owner 的库发 chat:send
   *    （刻意不 kb:join：房间归属与本条无关，网关也不查它）
   * 3. 断言只收到一条 chat:error，且是网关准入那一句文案
   * 4. 断言 meta/delta/done 一条都没来（流根本没开始，也就没有半条回答可落库）
   * 5. 断言 owner 的库里没有新会话、没有消息行
   * 为什么这条不是空跑（把 :352 的 require 摘掉会怎样）：那时 run() 自己的步骤 1
   * （chat.service.ts#run 的步骤 1，同一个 require）照样抛错，网关走 catch 的非中止分支，
   * 发的是另一句『生成失败，请稍后重试』——第 3 步的字面断言立刻红。
   * 所以本用例钉的是「在哪一层拦住的」，而不只是「拦没拦住」；
   * 反过来把 required 参数从 viewer 放宽成 editor，第 3 步也会红（正常提问的 invader 会变成有权）
   */
  it('denies chat:send against another organization KB before running it', async () => {
    const owner = await createWorkspace('f');
    const intruder = await createWorkspace('g');
    const socket = await connectSocket(port, intruder.cookie);
    try {
      // 三条「不该出现」的事件先各自记账，等 error 到达后再收口断言
      const unexpected = { meta: [] as unknown[], delta: [] as unknown[], done: [] as unknown[] };
      socket.on('chat:meta', (payload: unknown) => unexpected.meta.push(payload));
      socket.on('chat:delta', (payload: unknown) => unexpected.delta.push(payload));
      socket.on('chat:done', (payload: unknown) => unexpected.done.push(payload));

      const errorPromise = waitForEvent<{ requestId: string; message: string }>(
        socket,
        'chat:error',
      );
      socket.emit('chat:send', {
        orgId: owner.orgId,
        kbId: owner.kbId,
        question: '别人的知识库我能问出什么？',
        requestId: 'r-cross',
      });
      // 步骤 3：字面钉文案——它是「网关准入层拦下」的指纹（见上面那段说明）
      expect(await errorPromise).toEqual({
        requestId: 'r-cross',
        message: '知识库不存在或无权访问',
      });

      // 步骤 4：给迟到事件一个缓冲（同一条 socket，毫秒级），不然「没收到」可能是测得太快
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(unexpected).toEqual({ meta: [], delta: [], done: [] });

      // 步骤 5：一个字节都没落库。会话数为 0 已经排除了消息行（messages 外键指向 conversations），
      // 但这里还是直接查一遍消息条数，免得将来外键关系变了这条断言悄悄失去意义
      const conversations = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM conversations WHERE kb_id = $1`,
        [owner.kbId],
      );
      expect(conversations.rows[0].count).toBe('0');
      const messages = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         WHERE c.kb_id = $1`,
        [owner.kbId],
      );
      expect(messages.rows[0].count).toBe('0');
    } finally {
      socket.close();
    }
  });
});
