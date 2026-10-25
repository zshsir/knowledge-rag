/**
 * 入库队列的消费入口：把 QueueService 的 worker 回调接到 IngestionService.process 上。
 * 全仓库只有这一处调用 queue.work()，也就是说只有这个文件会让 worker 进程真的取任务。
 * 职责：只做「接线 + 打一行开始日志」，共两件事——
 *      1）在模块初始化时注册消费循环；2）把拿到的 IngestJob 原样交给 IngestionService。
 * 不做什么：不理解解析/切分/嵌入（在 ingestion.service.ts 与 parsing/ 下）、
 *      不改 documents.status（由 IngestionService 维护）、不写重试与退避策略（在 pg-boss 侧，
 *      参数见 queue.service.ts）、不做并发控制（并发度 = QueueService.work 注册的 worker 个数，
 *      取自 WORKER_CONCURRENCY）。
 * 装载范围：只在 worker 进程存在。WorkerModule 把本类列进 providers 才触发 onModuleInit；
 *      API 进程走 AppModule，不含本类，所以 API 只投递不消费（见 ingestion.module.ts 与 worker.module.ts 的头注释）。
 * 实例形态：providers 里没写多个 provider，Nest 默认单例——一个 worker 进程内只有一个 IngestionProcessor，
 *      因此 onModuleInit 只会注册一轮消费循环（一轮里可能有多个 worker，取决于 WORKER_CONCURRENCY）。
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { QueueService } from '../queue/queue.service';
import { IngestionService } from './ingestion.service';

@Injectable()
export class IngestionProcessor implements OnModuleInit {
  private readonly logger = new Logger(IngestionProcessor.name);

  constructor(
    private readonly queue: QueueService,
    private readonly ingestion: IngestionService,
  ) {}

  /**
   * 容器初始化时拉起消费循环。
   * 步骤：
   * 1. 调 queue.work(handler)：它会先检查 pg-boss 客户端是否已就绪，没就绪直接抛
   *    ServiceUnavailableException——失败发生在启动阶段、进程起不来，比「进程活着但永远不取任务」
   *    更容易被发现（与 QueueService.onModuleInit 里 start() 的取向一致）。就绪前提是
   *    QueueService 自己的 onModuleInit 已经跑过。
   * 2. work() 按 WORKER_CONCURRENCY 注册那么多个独立 worker（batchSize 1、轮询 2 秒），
   *    注册完就 resolve 并返回，不等任务跑完——所以本方法很快返回、bootstrap 能继续打印启动标记，
   *    之后靠 pg-boss 的轮询把进程吊住
   * 3. 每取到一个 job 就执行这里的回调：先打一行 `processing document <documentId>`，
   *    再 await ingestion.process(job)
   * 4. 回调里的异常一律不 catch，直接往外抛给 pg-boss：pg-boss 据此判定该次尝试失败并按
   *    队列配置重试。IngestionService 把「永久不可用」那一类（例如空文档）刻意收敛成正常返回，
   *    就是为了不白耗这几次重试
   *
   * 关于那行日志：它标的是「本次尝试开始」，不是「这份文档第一次开始」——同一条任务重试时会再进
   * 回调一次，所以一份反复失败的文档在日志里会出现多行同样的 documentId。
   */
  async onModuleInit() {
    await this.queue.work(async (job) => {
      // 步骤 3：documentId 只用于日志定位，业务取数靠 ingestion 自己按 (id, org_id) 查
      this.logger.log(`processing document ${job.documentId}`);
      await this.ingestion.process(job);
    });
  }
}
