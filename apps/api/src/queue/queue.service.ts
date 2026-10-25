/**
 * pg-boss 的封装：投递「文档入库」任务，并在 worker 进程里注册消费循环。
 *
 * 为什么选 pg-boss（刻意的技术取舍，不是随手选的）：
 * - 需求很小：上传后异步做「解析 + 切分 + 嵌入」，量级是个位数到几十篇文档，
 *   需要的是持久化、重试与至少一次执行，不需要毫秒级延迟或百万级吞吐
 * - 复用已有的 Postgres：任务行就放在同一个库的 pgboss schema 里，于是备份、监控、连接串、
 *   运维手册全部沿用现成那套，不必为队列再引入 Redis / RabbitMQ / 一个 broker 进程
 *   （部署形态是 Docker Compose，多一个组件就多一份失败面）
 * - 排查便利：任务与 documents 行同库，「状态为什么一直停在 queued」一条 SQL 能同时看两边
 * - 代价也如实写：靠轮询而非推送（worker 每 2 秒查一次）、多占一份 PG 连接
 *   （本服务自己开 max:5 的池，与 DatabaseService 的池是两份），并发入队很大时 PG 会成为瓶颈
 *
 * 进程分工：API 进程只 send，worker 进程只 work（消费点在 ingestion.processor.onModuleInit），
 * 所以解析与嵌入这些重活不挤占 HTTP 请求的 CPU 与连接。
 *
 * 职责边界：
 * - 不理解任务内容：负载只是 queue.constants.ts 里那四个 id，本文件不碰 documents 表
 * - 不做业务级幂等：重复入队就排两个任务，靠 ingestion「先删旧 chunks 再整体插新」兜住结果一致
 * - 不管失败文案：任务失败由 ingestion 自己把 documents.status 写成 failed 并记 error
 * - 也不管进度广播：处理到哪一步了由 ingestion 发 pg_notify，实时侧另说
 */
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import PgBoss from 'pg-boss';
import { AppConfigService } from '../config/config.service';
import { DOCUMENT_QUEUE, IngestJob } from './queue.constants';

@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private boss?: PgBoss;
  // 启动标记：health() 与「没启动就拒投递」看的都是它，不是 boss 对象本身
  private started = false;

  constructor(private readonly config: AppConfigService) {}

  // 容器初始化即启动：pg-boss 内部会跑迁移建表，起不来就让它抛在 onModuleInit 里，
  // 进程直接启动失败——比「进程活着但所有投递都 503」更容易被发现
  async onModuleInit() {
    await this.start();
  }

  /**
   * 用配置里的数据库参数拼一个连接串给 pg-boss。
   * 用户名与口令过 encodeURIComponent：口令含 @ : / # 时不会拼断连接串结构，库名同理。
   * ssl 为真时追加 ?sslmode=require——不追加就变成「配了 SSL 但底层仍走明文」的静默降级。
   * 注意这是与 DatabaseService 完全独立的一份连接配置，两边各建各的池。
   */
  private connectionString() {
    const db = this.config.db;
    const query = db.ssl ? '?sslmode=require' : '';
    return `postgresql://${encodeURIComponent(db.user)}:${encodeURIComponent(
      db.password,
    )}@${db.host}:${db.port}/${encodeURIComponent(db.database)}${query}`;
  }

  /**
   * 启动 pg-boss 并声明队列。步骤：
   * 1. started 挡住重复启动：onModuleInit 与任何后续调用都只会真正启动一次
   * 2. new PgBoss：schema 固定 'pgboss'，所有队列表建在这个独立 schema 下，
   *    不与业务表混在 public（清理或排查时不会误伤数据）；max:5 是它自己的连接池上限
   * 3. 挂 error 监听：pg-boss 内部的异步错误若无人接会按未处理事件冒出来，
   *    这里只记日志——队列抖动不该带走整个进程
   * 4. start()：跑 pg-boss 自己的建表/迁移（外层包 pg_advisory_xact_lock，
   *    API 与 worker 同时启动会被串行化，不会互相踩 schema）
   * 5. createQueue 声明队列并写死「队列级默认参数」——这些就是 send 时不单独覆盖所生效的值：
   *    - retryLimit: 2 —— 失败最多再试 2 次（总共 3 次执行）。嵌入模型 5xx 这类瞬时故障值得重试，
   *      再多只会堵队列，且 documents.status 已有 failed + 人工重试按钮兜底
   *    - retryDelay: 15 + retryBackoff: true —— 以 15 秒为基础的指数退避，
   *      pg-boss 侧算的是 retry_delay + 2^min(retry_count+1,16)/2 * (1 + random()) 秒
   *      （pg-boss src/plans.js:819-827），即「指数 + 抖动」，避免一批同时失败的文档同秒集体重试
   *    - expireInSeconds: 1800 —— 单任务最长 30 分钟，是「大文档 + 慢模型」的兜底上限；
   *      worker 会用它限制回调执行时长，超时判失败并进入重试
   *    - deleteAfterSeconds: 86_400 —— 终态任务留 24 小时后删除：刚出事还能回查，
   *      又不至于让 pgboss.job 无限增长
   *    没写的项走 pg-boss 默认：队列 policy 'standard'（这一条对下面的 singletonKey 很关键）、
   *    retryDelayMax 不设上限
   * 6. 全部成功才落下 boss 与 started；中途抛错则维持「未启动」，后续调用一律 503
   */
  private async start() {
    if (this.started) return;
    const boss = new PgBoss({
      connectionString: this.connectionString(),
      schema: 'pgboss',
      max: 5,
    });
    // 步骤 3：不接 error 事件的后果是进程被内部异步错误带走
    boss.on('error', (error: Error) => this.logger.error(error.message));
    await boss.start();
    await boss.createQueue(DOCUMENT_QUEUE, {
      retryLimit: 2,
      retryDelay: 15,
      retryBackoff: true,
      expireInSeconds: 1800,
      deleteAfterSeconds: 86_400,
    });
    this.boss = boss;
    this.started = true;
  }

  /**
   * 投递一个文档入库任务，成功返回 jobId。步骤：
   * 1. 没有 boss（还没启动或已停机）→ 503「任务队列尚未就绪」。调用方 documents.service
   *    会把它翻成「任务入队失败，请稍后重试」并回滚已落盘的文件
   * 2. send 带 singletonKey
   * 3. 返回 null（pg-boss 用 null 表示「这条没插进去」）→ 同样 503
   *
   * 关于 singletonKey，按代码的实际情况说清楚（很容易误解，改这里之前务必读完）：
   * - key 是 `ingest-${documentId}-${Date.now()}`，带了毫秒时间戳，所以每次投递得到的都是新 key
   * - 且 pg-boss 的去重靠队列 policy 对应的部分唯一索引（short / singleton / stately / exclusive），
   *   本队列 createQueue 没指定 policy，取默认 'standard'（pg-boss src/manager.js:553），
   *   那几条索引的 WHERE 条件都不成立
   * 两个原因各自都足以让「按 key 去重」不生效：重复点重试、重复上传会各排一个 job。
   * 现状不重复的原因是 ingestion 的写法（同一文档重跑先 DELETE 旧 chunks 再整体插入）+ documents.service.retry
   * 对 processing 的拦截，而不是这里。
   * 这个 key 目前实际只起标签作用：在 pgboss.job 里按文档回查任务时很好用。
   */
  async sendDocument(payload: IngestJob): Promise<string> {
    if (!this.boss) {
      throw new ServiceUnavailableException('任务队列尚未就绪');
    }
    const jobId = await this.boss.send(DOCUMENT_QUEUE, payload, {
      singletonKey: `ingest-${payload.documentId}-${Date.now()}`,
    });
    if (!jobId) {
      throw new ServiceUnavailableException('任务入队失败');
    }
    return jobId;
  }

  /**
   * 注册消费循环（只在 worker 进程被调用，调用点是 ingestion.processor.onModuleInit）。步骤：
   * 1. 未启动 → 503：worker 起不来比「静默不消费」好排查
   * 2. concurrency = max(1, workerConcurrency)：这里的 Math.max 只兜「0 或负数」这一种下限情况，
   *    它兜不住 NaN（Math.max(1, NaN) 就是 NaN，for 循环一次都不进，进程看着活着却永远不取任务）。
   *    NaN 那条路已经在启动闸口堵死了：WORKER_CONCURRENCY 必须是 ≥1 的整数，否则
   *    AppConfigService.onModuleInit 直接抛错、api 与 worker 都起不来（config.service.ts 的
   *    assertNumeric 调用）。所以到这里的值一定是合法整数，max(1, …) 只是 belt-and-braces
   * 3. 循环注册 concurrency 个独立 worker。这里的 await 不会卡住循环，因为 boss.work 在
   *    「worker 注册完成」时就 resolve 并返回 worker id（pg-boss src/manager.js:118-121，
   *    watch 末尾 return id），轮询与回调都在后台继续，所以确实能注册出多个
   * 4. 每个 worker 的参数：batchSize 1（一次只取一个文档——单条任务本身就长又吃内存，批量取没意义）、
   *    pollingIntervalSeconds 2（与 pg-boss 默认同为 2 秒，此处显式写出以免被默认值改动影响）
   * 5. 回调里对 jobs 逐个 await 顺序处理：并发度只来自「注册了几个 worker」，
   *    单个 worker 内部串行，所以真实同时在处理的文档数就等于 concurrency
   * 6. 打一行日志说明注册了几个 worker（部署时唯一的核对点）
   *
   * 失败语义：handler 抛异常 → pg-boss 判这条失败 → 按上面的 retryLimit 与退避重投。
   * ingestion 里「内容永久不可用」那一类错误（如空文档）故意不抛，就是为了不白耗这 2 次重试。
   * 边界：本方法不等任务跑完，也不提供单独注销（停机统一走 onModuleDestroy 的 stop）。
   */
  async work(handler: (payload: IngestJob) => Promise<void>): Promise<void> {
    if (!this.boss) {
      throw new ServiceUnavailableException('任务队列尚未就绪');
    }
    // 步骤 2：只对 0/负数取下界；NaN 已由启动校验拦掉，这里不可能收到
    const concurrency = Math.max(1, this.config.workerConcurrency);
    for (let index = 0; index < concurrency; index += 1) {
      await this.boss.work<IngestJob>(
        DOCUMENT_QUEUE,
        {
          batchSize: 1,
          pollingIntervalSeconds: 2,
        },
        async (jobs) => {
          // 步骤 5：batchSize=1 时数组通常只有一个元素，仍逐个 await，语义是串行
          for (const job of jobs) {
            await handler(job.data);
          }
        },
      );
    }
    this.logger.log(
      `worker listening on ${DOCUMENT_QUEUE} (concurrency=${concurrency})`,
    );
  }

  /**
   * 给健康探针用的队列状态：只回答「本进程的 pg-boss 起来没有」，不查库、也不看积压条数。
   * 返回 'ok' / 'down' 字符串，由 health.controller 汇总成整体探针结果。
   */
  health(): 'ok' | 'down' {
    return this.started ? 'ok' : 'down';
  }

  /**
   * 优雅停机。步骤：
   * 1. 没有 boss 直接返回（没启动过就退出，属正常）
   * 2. await boss.stop()：停止各 worker 的轮询并等在途任务收尾，而不是让容器的 SIGTERM
   *    把正在跑的解析砍成半截——砍掉的后果是 documents 停在 processing，只能靠用户点重试
   * 3. 出错只 warn 不抛：停机阶段再抛异常会打断 Nest 的 shutdown 钩子链，
   *    后面的连接池关闭就跑不到了
   * 4. finally 清 boss 引用并把 started 置回 false：即使 stop 失败，本进程对外也不再声称就绪，
   *    后续 send 一律走 503 分支
   */
  async onModuleDestroy() {
    if (!this.boss) return;
    try {
      await this.boss.stop();
    } catch (error) {
      this.logger.warn(
        `queue shutdown failed: ${error instanceof Error ? error.message : error}`,
      );
    } finally {
      this.boss = undefined;
      this.started = false;
    }
  }
}
