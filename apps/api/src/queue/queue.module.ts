/**
 * 队列模块：@Global 提供 QueueService。
 *
 * 两侧都要它，但用的方法不同：
 * - API 进程（app.module.ts）只调 sendDocument 投递，不注册消费者，所以投出去的任务
 *   不会在 API 里执行——解析、嵌入这些重活留在 worker 进程
 * - worker 进程（worker.module.ts）只调 work 拉起消费循环（由 ingestion.processor 触发）
 * 两边的 onModuleInit 都会 start() 同一个 PgBoss 服务：pg-boss 启动时跑自己的建表/迁移，
 * 语句外面包了 pg_advisory_xact_lock（见 pg-boss src/plans.js:985-1001），
 * 所以 API 与 worker 同时启动会被串行化，不会互相踩 schema。
 * 做成全局省掉两处重复 import；服务本身无请求态，跨模块共享一个实例正是需要的（一个 PgBoss 连接池）。
 *
 * 边界：本模块不含 ingestion 模块，也不认识「任务该做什么」——它只管投递与注册回调，
 * 具体处理逻辑由 ingestion.processor.ts 在 WorkerModule 里注册。
 */
import { Global, Module } from '@nestjs/common';
import { QueueService } from './queue.service';

@Global()
@Module({
  providers: [QueueService],
  exports: [QueueService],
})
export class QueueModule {}
