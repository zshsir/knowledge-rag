/**
 * 健康探针模块：只把 HealthController 挂进路由表。
 * 为什么 imports 是空的：控制器要注入的 DatabaseService 与 QueueService 来自
 * DatabaseModule 和 QueueModule，这两个模块都标了 @Global 并已 exports 这两个提供者
 * （见各自文件头），所以本模块不需要 import 就能解析依赖。
 * 边界：本模块不提供、也不导出任何服务；没有守卫、没有管道，除了控制器本身不拥有别的东西。
 * 注册位置：app.module.ts 的 imports 列表（全平台唯一的探针模块，worker 进程不加载它）。
 */
import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

@Module({
  controllers: [HealthController],
})
export class HealthModule {}
