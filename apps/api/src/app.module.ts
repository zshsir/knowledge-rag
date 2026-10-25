/**
 * API 进程的根模块：把全局基础设施与各业务模块拼成一个可监听的应用。
 *
 * 职责边界：
 * - 只做「组合」：列依赖、注册全局守卫与过滤器，不含任何控制器、管道或业务逻辑
 * - 是 HTTP 进程专属的装配：worker 进程用的是 worker.module.ts，那里不加载 auth / chat 这些只属于请求侧的模块
 * - 新增业务模块必须同时出现在 imports 里，否则其控制器不会被注册
 */
import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { AppConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { AccessEventsModule } from './common/events/access-events.module';
import { StorageModule } from './storage/storage.module';
import { LlmModule } from './llm/llm.module';
import { QueueModule } from './queue/queue.module';
import { AuthModule } from './auth/auth.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { KnowledgeBasesModule } from './knowledge-bases/knowledge-bases.module';
import { DocumentsModule } from './documents/documents.module';
import { ChatModule } from './chat/chat.module';
import { RealtimeModule } from './realtime/realtime.module';
import { HealthModule } from './health/health.module';
import { AppThrottlerGuard } from './common/guards/app-throttler.guard';
import { OriginGuard } from './common/guards/origin.guard';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

@Module({
  imports: [
    // —— 全局基础设施（标了 @Global，业务模块无需重复 import）——
    AppConfigModule, // 环境变量读取、默认值与必填校验
    DatabaseModule, // 连接池、事务入口与身份/组织相关仓储
    AccessEventsModule, // 跨模块访问事件总线，供审计与实时推送解耦
    // —— 能力层：被业务模块消费的对外服务 ——
    StorageModule, // 上传文件的落盘与读取
    LlmModule, // 对话模型与嵌入模型
    QueueModule, // 入库任务队列：API 侧只投递，消费在 worker 进程
    // —— 全平台限流兜底：60 秒 100 次，单个接口可用 @Throttle 收紧 ——
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    // —— 业务模块（大致按请求依赖的方向排列：先身份，再组织/库，最后文档与问答）——
    AuthModule, // 注册、登录、会话
    OrganizationsModule, // 组织、成员、邀请
    KnowledgeBasesModule, // 知识库与知识库级权限
    DocumentsModule, // 文档上传、列表、重试
    ChatModule, // 检索增强问答与会话历史
    RealtimeModule, // WebSocket 推送入库进度
    HealthModule, // 存活/就绪探针
  ],
  providers: [
    // APP_GUARD 按数组顺序执行：先限流、再校验 Origin。
    // 被限流挡掉的请求不该再消耗一次 Origin 判断，也不该给探测者留下「Origin 是否被接受」的回声
    { provide: APP_GUARD, useClass: AppThrottlerGuard },
    // Origin 守卫承担跨站防护：带 Origin 且与 APP_ORIGIN 不一致的写请求一律拒绝（GET/HEAD/OPTIONS 放过），
    // 它拦的是「别的站点带着用户的 httpOnly cookie 来发请求」这一类 CSRF 场景
    { provide: APP_GUARD, useClass: OriginGuard },
    // 统一异常出口：把内部错误压成固定响应结构，避免堆栈或数据库细节泄漏到前端
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
