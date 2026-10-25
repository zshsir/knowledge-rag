/**
 * 权限回收事件模块：只提供 AccessEventsService 这一个进程内总线。
 * @Global() + exports：知识库/组织/实时推送等模块无需显式 import 本模块即可注入，
 * 这是一个刻意做小的公共设施（与 database、storage 等全局模块同套路）。
 * 边界：模块本身无控制器、无监听器，纯装配。
 */
import { Global, Module } from '@nestjs/common';
import { AccessEventsService } from './access-events.service';

@Global()
@Module({
  providers: [AccessEventsService],
  exports: [AccessEventsService],
})
export class AccessEventsModule {}
