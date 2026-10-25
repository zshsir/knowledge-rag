/**
 * socket.io 网关：在线用户的房间归属、入库进度广播、以及流式问答的四段推送都在这一个类里。
 *
 * 最重要的一条前提（改这个文件前先接受这个事实）：
 * WebSocket 不走 HTTP 中间件与 APP_GUARD。cookie-parser、OriginGuard、AuthGuard、ThrottlerGuard、
 * 全局异常过滤器全都是 Express 层的，socket.io 的握手与消息由自己的适配器处理，
 * 所以「身份、跨站、限流、错误兜底」这四件事必须在本网关里自己做，不能因为「全局已经配过了」就省掉。
 *
 * 自己做的四处分别是：
 * - 握手期：afterInit 里的 server.use 中间件做 Origin 校验 + 会话校验（见该方法注释）
 * - 每条要紧的消息：kb:join 与 chat:send 先 revalidate（会话是否还有效）再 kbAccess.require（权限现判）
 * - 限流：allowChat 自己算 60 秒滑动窗口，因为 ThrottlerGuard 拦不到 socket
 * - 错误：不发裸异常，一律转成 chat:error 的中文文案；未捕获的错误只记日志
 *
 * 两个房间命名约定（都是字符串前缀，没有注册表）：
 * - kb:{kbId} —— 正在看这个知识库的人，收 document:status 广播
 * - user:{userId} —— 每条连接建立时自己进，收与该人直接相关的消息（撤权通知、
 *   以及作为上传者收 document:status）
 *
 * chat 事件协议（一次问答 = 一个 requestId 串起若干事件）：
 * 客户端 emit chat:send{requestId,orgId,kbId,conversationId?,question} →
 * 服务端按序 emit chat:meta{requestId,conversationId,userMessageId,sources}（检索完成，先给引用）→
 * chat:delta{requestId,text}（0 到多次，模型增量）→ chat:done{requestId,assistantMessageId,conversationId,cancelled}
 * 或 chat:error{requestId,message}。前端靠 requestId 把收到的事件对上自己发的那一次请求。
 * 取消语义：客户端 emit chat:cancel{requestId} → 网关 abort 本次的 AbortController →
 * chat.service 捕获中止：已经生成过内容就把这部分落库（消息行带 interrupted=true），
 * 一段都没生成就什么都不写；两种情况都让 run 返回 interrupted:true → 上面那条 done 里 cancelled=true。
 * 也就是说「取消」是正常结束的一种，不走 error，前端不该弹错误提示。
 * 这里的不变式是「每一条 abort 出口都以一条 done 收场」，包括第三种出口：落半条回答时数据库写入
 * 自己失败——那时 run 抛出而 signal 已 abort，第 10b 步补发一条 done{assistantMessageId:null,
 * cancelled:true}。少这一条前端就永远停在流式态（转圈 + 停止按钮点不动），所以这里宁可用 null
 * 收尾也不允许静默。
 *
 * 鉴权覆盖面（不对称，如实记录）：
 * - 重新鉴权的：kb:join、chat:send（每条消息都 revalidate + kbAccess.require）
 * - 不重新鉴权的：kb:leave、chat:cancel。这两条不需要，因为它们只做「影响自己这条连接」的事：
 *   leave 是把本连接从它自己已在的房间移出，cancel 只读本连接私有的 socket.data.active，
 *   既读不到别人的 requestId 也控制不了别人的流。写成「每条消息都会重新鉴权」是错的
 * - 留在 kb 房间里能干什么：继续收到该库的 document:status 广播（载荷见 broadcastDocumentStatus），
 *   仅此而已——要拿数据必须再发 chat:send 或走 HTTP，那两条都会重新判
 *
 * 职责边界：不含业务规则（问答在 ChatService、权限在 KbAccessService、会话在 SessionService），
 * 也不管数据库通知怎么来（见 realtime.listener.ts）。
 */
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { Logger, OnModuleDestroy } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { Subscription } from 'rxjs';
import { AppConfigService } from '../config/config.service';
import { SessionService } from '../auth/session.service';
import { KbAccessService } from '../knowledge-bases/kb-access.service';
import { ChatService } from '../chat/chat.service';
import { AccessEventsService } from '../common/events/access-events.service';
import { AuthUser } from '../common/types';
import { parseCookieHeader } from './socket-cookie';

/** kb:join / kb:leave 的负载。两个字段全可选——校验在服务方法里做，类型只负责让 TS 不炸 */
interface JoinPayload {
  orgId?: string;
  kbId?: string;
}

/**
 * chat:send 的负载。requestId 由前端生成、服务端原样回带；
 * conversationId 可选——不带就由 ChatService 新建一个会话并在 chat:meta 里回给前端。
 * 全部标成可选是刻意的：请求体来自客户端，缺什么都在方法里判成错误返回，而不是靠类型假装它一定有。
 */
interface ChatSendPayload {
  orgId?: string;
  kbId?: string;
  conversationId?: string;
  question?: string;
  requestId?: string;
}

/**
 * pg_notify('kr_document_status', ...) 送来的载荷形状，由 ingestion.service.notify 那边生成。
 * orgId 在这里但对外广播时会被剔掉；uploadedBy 可为 null（文档的作者后来被删了）。
 */
interface DocumentStatusPayload {
  documentId: string;
  orgId: string;
  kbId: string;
  uploadedBy: string | null;
  status: string;
  chunkCount: number;
  error: string | null;
}

// 不传任何参数：端口与 HTTP 服务复用 Nest 已经创建的那个 Express 实例（同域部署，
// 因此浏览器会自动带上 httpOnly 会话 Cookie），路径走 socket.io 默认的 /socket.io，
// 不受 app.setGlobalPrefix('api') 影响；跨站防护不靠这里的 CORS 配置，而靠下面握手期的 Origin 校验
@WebSocketGateway()
export class RealtimeGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  private readonly logger = new Logger(RealtimeGateway.name);
  private server?: Server;
  // 持有订阅句柄，好在 onModuleDestroy 时精确退订（进程内总线不会随连接断开而清理）
  private accessSubscription?: Subscription;
  /** chat 限流表：userId → 最近若干次请求的时间戳。只在进程内存里，重启清零，多实例各算各的 */
  private readonly chatRate = new Map<string, number[]>();

  constructor(
    private readonly config: AppConfigService,
    private readonly sessions: SessionService,
    private readonly kbAccess: KbAccessService,
    private readonly chat: ChatService,
    private readonly accessEvents: AccessEventsService,
  ) {}

  /**
   * 网关初始化：socket.io 服务端已经建好，这里是第一次拿到 server 引用的地方，
   * 握手期中间件就挂在这（晚于任何连接建立，早于 handleConnection）。
   * 步骤：
   * 1. 存下 server 引用（后面的广播与撤权都要用它）
   * 2. server.use 注册握手中间件——它只在连接建立那一刻跑，之后每条消息不再经过：
   *    a. Origin 校验：握手头里带了 Origin 且不等于 APP_ORIGIN 就拒。
   *       没有 Origin 头的连接（非浏览器客户端：curl、原生 App、自动化脚本）这一条不拦，
   *       它专职挡的是「别的网站带着用户的 Cookie 来连」这一类跨站场景，与 OriginGuard 同一思路
   *    b. 令牌取自手工解析的 Cookie 头里的 kr_session。必须自己解：握手不经过 Express，
   *       没有 cookie-parser，也没有 request.cookies。键名在这里是字面量，
   *       与 session.service 的 SESSION_COOKIE 常量是两处写法（改 Cookie 名要一起改）
   *    c. sessions.verify 查库确认会话有效（登出、改密码、过期都在这里生效）
   *    d. 把 user / sessionId / rawToken 挂到 socket.data，供 handleConnection 与 revalidate 用
   *    任何一步失败都统一 next(new Error('unauthorized'))：对外只留一种原因，
   *    不告诉请求方「是 Origin 不对」还是「没登录」。代价是 catch 把原始错误整个吞掉，
   *    握手为什么失败在服务端日志里查不到，只能靠客户端错误文案猜
   * 3. 订阅进程内的权限回收事件总线：对每个受影响的用户，从他的 user:{id} 房间里把该库的房间退掉，
   *    再单独推一次 kb:access-revoked 让前端刷新可见列表。
   *    这是「通知」不是「执法」——真正拦住他的是下一次 kb:join / chat:send / HTTP 请求的重新判定。
   *    另有一个部署层面的限制：这条总线只在进程内，多实例部署时只有持有该连接的那个实例收到事件，
   *    别的实例上的旧连接不会被踢出房间（后果同上：只是多收广播，拿不到数据）
   */
  afterInit(server: Server) {
    this.server = server;
    server.use(async (socket, next) => {
      try {
        // 步骤 2a：Origin 校验（无 Origin 头的非浏览器客户端放行）
        const origin = socket.handshake.headers.origin;
        if (origin && origin !== this.config.appOrigin) {
          throw new Error('origin rejected');
        }
        // 步骤 2b：握手期没有 cookie-parser，只能自己解 Cookie 头
        const rawToken = parseCookieHeader(
          socket.handshake.headers.cookie,
        )['kr_session'];
        if (!rawToken) throw new Error('missing session');
        // 步骤 2c：查库验会话；登出/改密码/过期都会在这里变成连接失败
        const session = await this.sessions.verify(rawToken);
        if (!session) throw new Error('invalid session');
        // 步骤 2d：身份落到 socket.data，rawToken 留着给 revalidate 复验
        socket.data.user = session.user;
        socket.data.sessionId = session.sessionId;
        socket.data.rawToken = rawToken;
        next();
      } catch {
        // 统一对外原因，细节不外泄（也不打日志，见上方代价说明）
        next(new Error('unauthorized'));
      }
    });

    // 步骤 3：撤权 → 退房间 + 通知
    this.accessSubscription = this.accessEvents.revocations$.subscribe(
      ({ userIds, kbId }) => {
        for (const userId of userIds) {
          const userRoom = `user:${userId}`;
          this.server?.in(userRoom).socketsLeave(`kb:${kbId}`);
          this.server?.in(userRoom).emit('kb:access-revoked', { kbId });
        }
      },
    );
  }

  /**
   * 连接建立（握手中间件已经通过）。步骤：
   * 1. 再确认 socket.data.user 在：不在就断开。正常情况下中间件保证了它在，
   *    这一条是防御性的，挡住「中间件被改动后连接匿名进来」
   * 2. 进 user:{id} 房间——所有与该人直接相关的推送都以这个房间为靶子
   * 3. 初始化 socket.data.kbIds 为空 Set：本连接加入过的库的登记表，join 加、leave 减。
   *    如实说明：这个 Set 目前只写不读（没有任何地方拿它做判断或清理），
   *    连接关闭时 socket.io 自己会把该 socket 移出所有房间，所以它现在只是可观测状态
   * 4. 挂一个 24 小时后强制断开的定时器：长连接不该无限存活（前端开了 reconnection，
   *    到点断开后会自己重连并重新走握手，等于一次例行的身份复验）
   * 注意 2/3 都是 void 或同步赋值：join 是异步的但不需要等它，后面的消息处理不依赖房间归属。
   */
  handleConnection(socket: Socket) {
    const user = socket.data.user as AuthUser | undefined;
    if (!user) {
      socket.disconnect(true);
      return;
    }
    // 步骤 2：每条连接自动在自己的「个人房间」里
    void socket.join(`user:${user.id}`);
    // 步骤 3：本连接的库房间登记表
    socket.data.kbIds = new Set<string>();
    // 步骤 4：24 小时寿命上限
    socket.data.expiry = setTimeout(
      () => socket.disconnect(true),
      24 * 60 * 60 * 1000,
    );
  }

  /**
   * 连接断开（客户端关页、网络断、24 小时到点都走这里）。步骤：
   * 1. 清掉到期定时器：不清的话它还会在 24 小时后触发一次对已关闭连接的 disconnect，
   *    白留一个悬挂计时器句柄
   * 2. 若本连接有在途问答流，abort 它：模型侧的 HTTP 流还在跑，
   *    不中止就会继续消耗配额，并且往一个已关闭的 socket 上 emit
   * 3. 清掉 socket.data.active
   * 这里的 abort 与 chat:cancel 走的是同一个控制器，区别只是发起方是断开而不是用户点停止。
   */
  handleDisconnect(socket: Socket) {
    if (socket.data.expiry) clearTimeout(socket.data.expiry);
    socket.data.active?.controller.abort();
    socket.data.active = undefined;
  }

  /** 进程销毁时退订权限回收事件总线：事件流是进程内的，不主动退订就会一直挂着这个闭包 */
  onModuleDestroy() {
    this.accessSubscription?.unsubscribe();
  }

  /**
   * 加入某个知识库的房间（前端进入库页面时调，用 emitWithAck 等返回值）。步骤：
   * 1. revalidate：会话现在还有效吗？无效直接 {ok:false}（连接也已在 revalidate 里断掉）
   * 2. orgId 与 kbId 必须都给，缺一个 → {ok:false}
   * 3. kbAccess.require(orgId, kbId, user.id, 'viewer')：真正的资格判定，viewer 即可听该库广播
   * 4. 通过才 join 房间，并把 kbId 记进本连接的 kbIds
   * 5. 返回 {ok:true, permission}：permission 是 require 解析出的有效权限。
   *    现状：前端（KbLayout）只读 ok，ok:false 走的是「实时权限校验未通过」整页（joinDenied）；
   *    「实时连接暂时不可用」那条 toast 来自 emitWithAck 超时/抛错的 catch，与 ok 无关。
   *    permission 字段暂时没人用
   * 失败原因（库不存在、跨组织、等级不够、抛异常）全部塌成同一个 {ok:false}：
   * socket 层不向外承认某个 kbId 是否存在，与 HTTP 侧「一律 404」的口径一致。
   * 注意「在房间里」不等于「有访问权」：房间只决定能不能收到广播，
   * 每条 chat:send 仍会重新 require 一次（见下）。
   */
  @SubscribeMessage('kb:join')
  async join(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: JoinPayload,
  ) {
    const user = await this.revalidate(socket);
    if (!user) return { ok: false };
    if (!payload?.orgId || !payload?.kbId) return { ok: false };

    try {
      // 步骤 3：viewer 门槛，判定完全复用 HTTP 侧那套 resolve（含组织成员、创建者、显式授权、org 公开）
      const permission = await this.kbAccess.require(
        payload.orgId,
        payload.kbId,
        user.id,
        'viewer',
      );
      await socket.join(`kb:${payload.kbId}`);
      // 步骤 4：登记，供 kb:leave 与本连接清理时对照
      (socket.data.kbIds as Set<string>).add(payload.kbId);
      return { ok: true, permission };
    } catch {
      // 404 / 403 / 任何异常在这里合并成一个布尔
      return { ok: false };
    }
  }

  /**
   * 离开某个知识库的房间（前端离开库页面时调）。
   * 刻意不做 revalidate / require：本方法只影响「发起者自己这条连接」收不收得到某个房间的广播，
   * 既拿不到别人的数据也不改变任何权限，多查一次库只会给每条消息加一次 IO。
   * 步骤：1. 要有 kbId 2. 退房间 3. 从本连接的登记表里删掉（用可选链：没进过 join 的连接没这个 Set 也不该炸）
   * 效果的可逆性要说清：退了之后还能再 join 回来，重新 join 时会完整重跑一遍鉴权，
   * 所以「不鉴权的 leave」不会被用来绕过什么。
   */
  @SubscribeMessage('kb:leave')
  async leave(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: JoinPayload,
  ) {
    if (!payload?.kbId) return { ok: false };
    await socket.leave(`kb:${payload.kbId}`);
    (socket.data.kbIds as Set<string> | undefined)?.delete(payload.kbId);
    return { ok: true };
  }

  /**
   * 流式问答的入口：一次 chat:send = 一次「检索 + 生成」，结果按 requestId 分多个事件推回。
   * 步骤（前 6 步全是准入检查，任一不过就只发一条 chat:error 然后返回）：
   * 1. revalidate：会话失效则直接 return——不再 emit，因为连接正在被关闭
   * 2. requestId / orgId / kbId 三项必给（requestId 缺失时回的事件里 requestId 是空串，
   *    前端拿不到对应关系，这是现状）
   * 3. 问题 trim 后长度 1~2000 字：上限只在这一处判，ChatService 不再复查长度
   *    （question 在下游用于检索、落库正文、拼提示词，以及取会话标题的前 30 字）
   * 4. 同一连接同时只允许一个在途流（socket.data.active 非空就拒），
   *    防止用户连点把并发压到模型侧，也保证 chat:cancel 只需中止「这一个」
   * 5. allowChat 限流：每用户 60 秒滑动窗口内 10 次
   * 6. kbAccess.require(viewer)：这条才是真正的执法点——房间成员身份不算资格，
   *    而且从 join 到现在可能权限已经变了
   * 7. 建 AbortController 并挂到 socket.data.active，cancel 与 handleDisconnect 都靠它中止
   * 8. chat.run 带三个回调：onMeta 推 chat:meta（会话 id、用户消息 id、引用片段先给前端渲染），
   *    onDelta 逐段推 chat:delta，都拼上同一个 requestId
   * 9. 正常结束推 chat:done，带 assistantMessageId / conversationId，
   *    并把 ChatResult.interrupted 映射成对外的 cancelled（前端据此区分「被取消」与「答完了」）
   * 10. 抛异常时分两支收尾，两支都必须发出一条终止事件：
   *     a. signal 未被 abort ⇒ 真故障：记一条 warn 并推 chat:error
   *     b. signal 已 abort ⇒ 只可能是中断收尾自己又炸了（落半条回答时 insert/touch 失败）：
   *        不推 chat:error（用户自己点的停止不是故障，也不把内部异常文案带出网），
   *        改为补推 chat:done{assistantMessageId:null, cancelled:true}，见该分支注释
   *     用户主动停止通常根本走不到这里——那种情况 chat.run 是正常返回 interrupted:true 的（第 9 步）
   * 11. finally 清 active：无论成功、失败还是取消，都要把「有一个在途流」这个标记摘掉，
   *     否则这个连接之后再也发不出问题
   */
  @SubscribeMessage('chat:send')
  async chatSend(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: ChatSendPayload,
  ) {
    const user = await this.revalidate(socket);
    if (!user) return;
    const requestId =
      typeof payload?.requestId === 'string' ? payload.requestId : '';
    // 步骤 2：三个必需参数
    if (!requestId || !payload?.orgId || !payload?.kbId) {
      socket.emit('chat:error', { requestId, message: '请求参数不完整' });
      return;
    }
    // 步骤 3：先 trim 再判长度，所以「全空格」等同于空问题
    const question = (payload.question ?? '').trim();
    if (!question || question.length > 2000) {
      socket.emit('chat:error', {
        requestId,
        message: '问题长度需在 1–2000 字之间',
      });
      return;
    }
    // 步骤 4：一条连接一个在途流
    if (socket.data.active) {
      socket.emit('chat:error', {
        requestId,
        message: '请等待当前回答完成',
      });
      return;
    }
    // 步骤 5：按用户算的滑动窗口限流
    if (!this.allowChat(user.id)) {
      socket.emit('chat:error', { requestId, message: '请求过于频繁，请稍后再试' });
      return;
    }

    // 步骤 6：权限现判。注意这里在限流之后——被限流挡掉的请求不会再去查库
    try {
      await this.kbAccess.require(payload.orgId, payload.kbId, user.id, 'viewer');
    } catch {
      socket.emit('chat:error', { requestId, message: '知识库不存在或无权访问' });
      return;
    }

    // 步骤 7：把中止句柄挂到本连接上，requestId 一起存，供 cancel 比对
    const controller = new AbortController();
    socket.data.active = { requestId, controller };
    // 步骤 7 补充：记下 chat:meta 里送出去的 conversationId，供异常收尾那条 done 复用。
    // 为什么不能直接回 payload.conversationId：新对话时它是 undefined，会话 id 是服务端在
    // meta 里第一次公布的；done 带错 id 会让前端拿 undefined/'' 覆盖掉 meta 刚写好的值
    // （chatReducer.ts:93-99），ChatPage 于是去拉 /conversations/undefined/messages
    // 并把 activeId 切成空（ChatPage.tsx:269-303）——又是一次渲染抖动
    let metaConversationId: string | undefined;

    try {
      // 步骤 8：三个回调就是这套协议的推送点，signal 一路传到模型 HTTP 请求
      const result = await this.chat.run({
        user,
        orgId: payload.orgId,
        kbId: payload.kbId,
        conversationId: payload.conversationId,
        question,
        signal: controller.signal,
        onMeta: (meta) => {
          metaConversationId = meta.conversationId;
          socket.emit('chat:meta', { requestId, ...meta });
        },
        onDelta: (text) => {
          socket.emit('chat:delta', { requestId, text });
        },
      });
      // 步骤 9：done 里的 cancelled 来自 interrupted（取消或部分落库都算 true）
      socket.emit('chat:done', {
        requestId,
        assistantMessageId: result.assistantMessageId,
        conversationId: result.conversationId,
        cancelled: result.interrupted,
      });
    } catch (error) {
      // 步骤 10a：没被 abort 的异常才是真故障——记 warn、发 chat:error。
      // 用户主动停止通常根本走不到这里（那种情况 chat.run 正常返回 interrupted:true，第 9 步），
      // 所以这个判断兜的是「已经决定中止了，收尾链路上又炸了一次」，不该把它说成生成失败
      if (!controller.signal.aborted) {
        this.logger.warn(
          `chat failed: ${error instanceof Error ? error.message : error}`,
        );
        socket.emit('chat:error', {
          requestId,
          message: '生成失败，请稍后重试',
        });
      } else {
        // 步骤 10b：signal 已 abort 而 run() 还是抛了 ⇒ 中断收尾自己失败了
        // （chat.service.ts 的 run() 生成阶段 catch：落半条回答时 messages.insert / conversations.touch 报错）。
        // 这里既不发 chat:error（用户点停止不是故障，也不把内部异常文案带出网），
        // 也【不能什么都不发】：前端只在收到 done 时才退出 status:'streaming'，
        // 少这一条气泡就永远转圈。229a2b1 立的不变式是「每条 abort 出口都要终止这次流」，
        // 这一步补的就是那个洞。assistantMessageId 给 null 是因为半条回答确实没落库成功，
        // 前端按「没有助手消息」收尾；conversationId 用 meta 已送出的真值（见步骤 7 补充）。
        // 回归测试：realtime.gateway.spec.ts 的「中断后落库失败仍然补发一条终止 chat:done」
        socket.emit('chat:done', {
          requestId,
          assistantMessageId: null,
          conversationId: metaConversationId ?? payload.conversationId ?? '',
          cancelled: true,
        });
      }
    } finally {
      // 步骤 11：清标记，否则这个连接被自己卡死
      socket.data.active = undefined;
    }
  }

  /**
   * 取消当前在途的生成（前端「停止生成」按钮）。语义要点：
   * 1. 只读 socket.data.active——这个字段是每条连接私有的，
   *    所以别的用户/别的标签页的流在这里根本不可见，abort 不到别人的请求
   * 2. requestId 必须与在途那条一致才动手。防的是前端把过期的 requestId 重发过来误伤当前这条流，
   *    属防呆而非访问控制——requestId 本来就是客户端自己生成的，冒充它没有意义，
   * 3. 不重新鉴权（同 kb:leave 的理由：只做影响自己的事），也不查会话是否还有效
   * 4. 无论有没有在途流、id 对不对得上，一律回 {ok:true}：取消是幂等的，
   *    「已经没有流了」对用户不是错误
   * 真正的收尾不在这里：abort 之后 chat.service 那边把已生成的部分落库并返回 interrupted:true，
   * chatSend 的第 9 步会推一条 cancelled:true 的 chat:done，第 10 步则刻意不推 chat:error。
   */
  @SubscribeMessage('chat:cancel')
  cancel(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: { requestId?: string },
  ) {
    const active = socket.data.active as
      | { requestId: string; controller: AbortController }
      | undefined;
    // 要点 2：id 对不上就当没这回事，什么都不做
    if (active && payload?.requestId === active.requestId) {
      active.controller.abort();
    }
    return { ok: true };
  }

  /**
   * 把一条文档状态变化推给相关的人。调用点只有一个：realtime.listener 收到
   * pg_notify('kr_document_status') 之后转过来（worker 进程发的，见 ingestion.service.notify）。
   * 步骤：
   * 1. server 还没初始化（极早期通知）就静默丢掉
   * 2. 重新组装载荷：只留 documentId / kbId / status / chunkCount / error 五个字段——
   *    orgId 与 uploadedBy 不出网关（前端本来就只在自己的组织上下文里看这个库），
   *    这里等于一次字段级白名单
   * 3. 目标先是 kb:{kbId} 房间；上传者存在时再并上 user:{uploadedBy}
   *    （.to() 是并集语义，多加一个房间而不是换个房间）
   * 4. emit document:status
   * 为什么还要并上 user 房间：用户刚传完文件时，前端可能还没 join 上这个库的房间（或刚好在跳转），
   * 让他至少能看到自己这份文档的进度。
   * 边界：没在任何一个目标房间里的人收不到——这就是这条推送的权限边界；
   * 反过来说，一个「已经不该再看这个库但连接还没断」的人会因为仍在 kb 房间里而继续收到广播，
   * 他收到的是状态 + 片段数 + 失败文案；正文内容不在其中（要读内容必须重新走 join/chat/HTTP 的判定）。
   * 但别把这条边界读成「零泄露」：error 是异常原始 message 截到 500 字符（ingestion.service 的
   *   errorMessage），可能带模型或嵌入服务内部细节——被撤销权限的人读不到正文，却仍能看到入库失败的技术原因。
   */
  broadcastDocumentStatus(payload: DocumentStatusPayload) {
    if (!this.server) return;
    const event = {
      documentId: payload.documentId,
      kbId: payload.kbId,
      status: payload.status,
      chunkCount: payload.chunkCount,
      error: payload.error,
    };
    let target = this.server.to(`kb:${payload.kbId}`);
    // 步骤 3：uploadedBy 可为 null（作者已被删），此时只推库房间
    if (payload.uploadedBy) target = target.to(`user:${payload.uploadedBy}`);
    target.emit('document:status', event);
  }

  /**
   * 每条要紧消息的复验：拿握手期存下的明文令牌再查一次会话。步骤：
   * 1. socket.data.rawToken 不在 → 断开并返回 null（这条连接不该继续服务）
   * 2. sessions.verify 查库；查不到（登出、改密码清会话、已过期）→ 断开并返回 null
   * 3. 有效则把最新的 user 覆写回 socket.data（用户改名之类的字段变化顺带刷新）并返回
   * 与 HTTP 侧 AuthGuard 的作用完全对应，只是这里必须手写。
   * 效果：会话一失效，最迟下一条 kb:join / chat:send 就把连接关掉；
   * 反过来说，kb:leave / chat:cancel 不做这一步，因此它们可以在会话已失效的连接上被接受
   * （但如前所述，这两条只做影响自己的事）。
   */
  private async revalidate(socket: Socket): Promise<AuthUser | null> {
    const rawToken = socket.data.rawToken as string | undefined;
    if (!rawToken) {
      socket.disconnect(true);
      return null;
    }
    const session = await this.sessions.verify(rawToken);
    if (!session) {
      // 不复用「未授权」的静默：直接把连接关掉，让前端走重连/跳登录
      socket.disconnect(true);
      return null;
    }
    socket.data.user = session.user;
    return session.user;
  }

  /**
   * chat 的进程内滑动窗口限流：同一用户 60 秒内最多 10 次，超了返回 false。
   * 步骤：
   * 1. 取出该用户的时间戳数组，只保留 60 秒内的
   * 2. 剩余条数 >= 10 → 判超限（顺手把过滤后的数组写回，让窗口滑起来）
   * 3. 未超限 →  push 当前时间戳并写回，返回 true
   * 为什么要自己做：ThrottlerGuard 挂在 HTTP 守卫链上，socket 消息不经过它，
   * 而一次问答会打一次嵌入 + 一次生成，是最贵的一类操作。
   * 三条如实的限制：只在单进程内存里（多实例各算各的）、重启清零、
   * 每个用户一个数组且只按时间过滤（用户注销后他那份条目会留在 Map 里直到下次被读到）。
   */
  private allowChat(userId: string): boolean {
    const now = Date.now();
    const recent = (this.chatRate.get(userId) ?? []).filter(
      (timestamp) => now - timestamp < 60_000,
    );
    if (recent.length >= 10) {
      // 步骤 2：写回过滤结果再拒绝，避免超限期间数组一直膨胀
      this.chatRate.set(userId, recent);
      return false;
    }
    recent.push(now);
    this.chatRate.set(userId, recent);
    return true;
  }
}
