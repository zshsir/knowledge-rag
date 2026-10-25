/**
 * 实时模块的装配：WebSocket 网关 + Postgres 通知监听器，两个 provider 一对。
 *
 * 依赖为什么是这五个（逐个说明，因为混合了「必须」与「只是声明」）：
 * - AuthModule（非 @Global）→ SessionService：握手鉴权与每条要紧消息的 revalidate 都靠它，
 *   这一行删不掉
 * - KnowledgeBasesModule（非 @Global）→ KbAccessService：kb:join 与 chat:send 的权限判定
 * - ChatModule（非 @Global）→ ChatService：chat:send 背后的检索 + 生成
 * - AccessEventsModule 与 DatabaseModule 都是 @Global：前者提供权限回收事件总线（网关订阅），
 *   后者提供连接池。写在这里是把依赖形状摊开给人看，删掉照样注入得到——
 *   本模块两个 provider 都不直接注入 DatabaseService，它是靠 AuthModule 那条链用到的
 * - 反过来，AppConfigService（Origin 校验要比对的 APP_ORIGIN）来自同样 @Global 的
 *   AppConfigModule，所以这里没有它的 import
 *
 * 结构上的两个关系：
 * - RealtimeListenerService 注入 RealtimeGateway（同模块内的 provider，不需要导出就能注入）：
 *   监听器负责「收到通知」，网关负责「推给谁」，方向单一，网关不知道通知从哪来
 * - exports 里的 RealtimeGateway 目前没有模块外消费者（worker 进程不装本模块），
 *   留着是给后续需要在别处主动广播的场景
 * 边界：本模块不含业务规则，也不建 socket 客户端；它只是把两个类装进容器并声明依赖。
 */
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AccessEventsModule } from '../common/events/access-events.module';
import { AuthModule } from '../auth/auth.module';
import { KnowledgeBasesModule } from '../knowledge-bases/knowledge-bases.module';
import { ChatModule } from '../chat/chat.module';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeListenerService } from './realtime.listener';

@Module({
  imports: [
    // @Global，只是声明
    DatabaseModule,
    // @Global，提供网关订阅的权限回收事件总线
    AccessEventsModule,
    // 以下三个非全局，是真正必需的依赖：AuthModule 供会话校验、
    // KnowledgeBasesModule 供知识库权限判定、ChatModule 供问答与流式生成
    AuthModule,
    KnowledgeBasesModule,
    ChatModule,
  ],
  // 顺序即依赖方向：监听器 → 网关 → 各业务服务
  providers: [RealtimeGateway, RealtimeListenerService],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
