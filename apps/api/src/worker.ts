/**
 * Worker 进程入口：只跑入库消费循环，不监听任何端口。
 *
 * 与 API 同镜像不同进程，只装载 WorkerModule，避免 API 进程加载 pdf-parse/canvas 导致 Jest 句柄泄漏
 * （pdf-parse 会连带引入 @napi-rs/canvas 原生模块，测试环境里只要被应用依赖图加载，就可能让 Jest 句柄不释放、跑完不退出）。
 *
 * 职责边界：
 * - 用 createApplicationContext 而不是 create：没有 HTTP 层，所以也不需要 cookie-parser、ValidationPipe、守卫
 * - 具体处理哪些任务由 IngestionProcessor 决定，本文件不理解文档、切片或向量
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  // 步骤 1：只实例化依赖注入容器（不起 HTTP 服务）
  const app = await NestFactory.createApplicationContext(WorkerModule);
  // 步骤 2：接管 SIGTERM/SIGINT，让容器编排停服时能触发 onModuleDestroy，
  // 从而把正在跑的解析任务收尾、把数据库连接池关掉，而不是被 SIGKILL 直接砍断
  app.enableShutdownHooks();
  // 步骤 3：打印启动标记。此处没有显式「开始消费」的调用——
  // IngestionProcessor 在 onModuleInit 里已经拉起轮询循环，容器创建完成即代表开始工作
  Logger.log('worker started', 'Bootstrap');
}
void bootstrap();
