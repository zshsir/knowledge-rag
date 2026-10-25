/**
 * Worker 进程的模块装配：只装「把文档变成向量」这条链路需要的东西。
 *
 * 职责边界：
 * - 刻意不导入 AuthModule / OrganizationsModule / KnowledgeBasesModule / ChatModule / RealtimeModule：
 *   worker 不处理 HTTP 请求，既不需要鉴权也不需要路由，多装一个模块就多一分启动失败面
 * - 也正因为不含这些模块，入库链路不能依赖请求上下文（没有 request.user），
 *   所有需要 org_id / kb_id 的信息都必须从任务负载或数据库里取
 * - providers 里显式列 IngestionProcessor：它不在 IngestionModule 内导出，靠这里实例化才能触发 onModuleInit 拉起消费循环
 */
import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { StorageModule } from './storage/storage.module';
import { LlmModule } from './llm/llm.module';
import { QueueModule } from './queue/queue.module';
import { IngestionModule } from './ingestion/ingestion.module';
import { IngestionProcessor } from './ingestion/ingestion.processor';

@Module({
  imports: [
    AppConfigModule, // 配置（并发数、切分参数、模型地址都由它给）
    DatabaseModule, // 连接池与仓储
    StorageModule, // 按 storageKey 读回原始文件
    LlmModule, // 嵌入模型：切片要转成向量才能被检索
    QueueModule, // 任务队列：worker 从这里取待处理的文档
    IngestionModule, // 解析 + 切分 + 写库的入库流水线
  ],
  // 消费循环的载体：容器初始化完成后它开始轮询队列，进程随之保活
  providers: [IngestionProcessor],
})
export class WorkerModule {}
