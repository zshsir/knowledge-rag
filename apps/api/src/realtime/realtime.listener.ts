/**
 * 文档状态的通知接收端：在 API 进程里挂一条独立的 Postgres 连接做 LISTEN，把收到的
 * kr_document_status 通知转交给实时网关广播。
 *
 * 为什么需要它（跨进程的一道必然环节）：
 * - 处理文档的是 worker 进程，那里没有 socket.io（WorkerModule 刻意不装 RealtimeModule），
 *   所以 worker 只能写库 + pg_notify，推送必须由持有连接的 API 进程来做
 * - pg_notify 是「即时投递、不持久化」的：那一刻没有任何监听者，这条通知就永久丢了，不会补发。
 *   这正是 ready 这个 Promise 想解决的问题——但它目前没被生产代码使用，见下面 ready 的注释
 * - 顺带得到多实例能力：每个 API 实例各自 LISTEN 同一个通道，各自收到同一份通知，
 *   于是各实例都能推自己手里那些连接（不需要 Redis pub/sub 之类的第二套广播）
 *
 * 通道名 kr_document_status 与载荷字段是两侧契约：
 * 发的一面是 ingestion.service.notify，收的一面是本文件，中间只经 JSON 字符串。
 *
 * 职责边界：
 * - 只搬运与解码，不查库、不判权限、不认识「谁该收到」——房间裁剪全在 RealtimeGateway
 * - 坏载荷只 warn 不抛：一条格式错的通知不该把整个监听器拆掉
 * - 只 LISTEN 这一个通道，别的事件（如权限变更）不走这里，走进程内的 AccessEventsService
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Client } from 'pg';
import { AppConfigService } from '../config/config.service';
import { RealtimeGateway } from './realtime.gateway';

@Injectable()
export class RealtimeListenerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeListenerService.name);
  private client?: Client;
  // 停机标记：置 true 后不再重连，事件回调里靠它挡住「关掉之后又冒出来的重试」
  private closed = false;
  private retryTimer?: NodeJS.Timeout;
  private readyResolve?: () => void;
  /**
   * 「LISTEN 已经挂上」的公开信号：resolve 点只有一处，就是 connect() 里查询成功之后。
   * 它想解决的问题很实在：worker 与 API 是同时启动的两个进程，如果通知在 LISTEN 生效前发出，
   * pg_notify 不补发，那份文档的进度就不会广播出去，前端要等下一次 refetch 才更新。
   * 但必须按现状说清楚：目前唯一 await 它的是 test/realtime.e2e-spec.ts（用 5 秒超时兜住），
   * 生产路径（main.ts 的 listen、health 探针、worker 启动）都没有等它，
   * 所以它现在不构成任何运行期保证，只保证测试能等到「真的听上了」再发通知。
   * 另外：resolve 只在第一次成功 LISTEN 时发生；断线重连后 ready 早已 settled，
   * readyResolve 再调一次是空操作，等待方看到的「就绪」不会随重连回来。
   */
  readonly ready = new Promise<void>((resolve) => {
    this.readyResolve = resolve;
  });

  constructor(
    private readonly config: AppConfigService,
    private readonly gateway: RealtimeGateway,
  ) {}

  /**
   * 启动时发起连接，但刻意不 await：LISTEN 挂上没挂上不该决定整个 API 能不能起来。
   * 连不上时靠 scheduleReconnect 自己在后台重试，HTTP 服务照常对外。
   */
  onModuleInit() {
    void this.connect();
  }

  /**
   * 停机：1. 先置 closed（挡住事件回调里后续的重连排程） 2. 清掉待触发的重试定时器
   * 3. end 当前连接，错误吞掉——停机阶段连不上库也不该让 shutdown 失败。
   * 注意 ready：如果直到此刻都没成功 LISTEN 过，这个 Promise 会永远 pending，
   * 等待方必须自己带超时（e2e 就是这么做的）。
   */
  async onModuleDestroy() {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.client) {
      await this.client.end().catch(() => undefined);
    }
  }

  /**
   * 建一条专用连接并挂上 LISTEN。步骤：
   * 0. closed 就什么都不做（停机后事件回调还会再进来一次，这里挡住）
   * 1. new Client(config.db)：LISTEN 必须独占一条连接，绝不能从 DatabaseService 的池里借
   *    （池化的连接会被别人复用，通道订阅就飘了）。这是库连接之外的第二条独立连接
   * 2. 注册三个事件：
   *    - notification：只认 kr_document_status 这个通道（同一条连接上别通道的噪声忽略），
   *      payload 为空也忽略；JSON 解析成功后整个交给 gateway.broadcastDocumentStatus，
   *      解析失败只 warn——一个坏载荷不能拖垮监听器
   *    - error：连接级错误（服务端断开、网络断）→ warn + 排重连
   *    - end：连接正常结束（对端关闭、client.end）→ 排重连
   * 3. connect 并执行 LISTEN；成功后把 client 存下来、resolve ready、记一条日志
   * 4. 任一步失败：warn、end 掉这个半途失败的 client（它占着一条 PG 连接）、排重连
   * 重连走的是「重新 new 一个 Client」，不复用旧实例；从 'error'/'end' 事件路径进来时旧实例
   * 没有被显式 end（只有第 4 步那条初始化失败的路径会 end），靠对端关闭与 GC 收尾。
   */
  private async connect() {
    if (this.closed) return;
    const client = new Client({ ...this.config.db });
    client.on('notification', (message) => {
      // 步骤 2：通道过滤 + 空载荷过滤
      if (message.channel !== 'kr_document_status' || !message.payload) return;
      try {
        const payload = JSON.parse(message.payload);
        // 字段是否与 DocumentStatusPayload 对得上由网关那侧的取值决定，这里不重复校验
        this.gateway.broadcastDocumentStatus(payload);
      } catch (error) {
        this.logger.warn(
          `invalid document status payload: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    });
    client.on('error', (error) => {
      this.logger.warn(`document status listener error: ${error.message}`);
      this.scheduleReconnect();
    });
    client.on('end', () => {
      this.scheduleReconnect();
    });

    try {
      await client.connect();
      await client.query('LISTEN kr_document_status');
      this.client = client;
      // 步骤 3：只在第一次成功 LISTEN 时点亮 ready
      this.readyResolve?.();
      this.logger.log('listening for document status notifications');
    } catch (error) {
      // 步骤 4：先关再重排，别让失败的连接悬在库里
      this.logger.warn(
        `failed to listen for document status: ${
          error instanceof Error ? error.message : error
        }`,
      );
      await client.end().catch(() => undefined);
      this.scheduleReconnect();
    }
  }

  /**
   * 排一次重连（已停机或已经排过就什么都不做，所以任何事件回调里都可以盲调）。
   * 如实说明这三点：
   * - 固定 5 秒间隔，没有指数退避也没有次数上限：库长时间不可用时就是每 5 秒试一次
   * - retryTimer 这个「至多一个」的约束就是防抖本身，多条事件同时进来也只会排一次
   * - 重试窗口里到达的通知会丢失（pg_notify 不持久化、不补发），
   *   后果只是文档进度不实时，数据本身已经在库里，前端 refetch 就能看到
   */
  private scheduleReconnect() {
    if (this.closed || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      // 先把句柄清空再连：这样 connect() 期间新来的事件才能再次排上一次重连
      this.retryTimer = undefined;
      void this.connect();
    }, 5000);
  }
}
