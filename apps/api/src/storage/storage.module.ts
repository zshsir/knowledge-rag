/**
 * 存储模块：把 StorageService 以 @Global 单例的形式提供给全应用。
 *
 * 为什么做成全局：落盘与回读这条能力跨三个使用方——documents.service（写与删）、
 * ingestion 的 ParserService（按 storageKey 读回原文）、knowledge-bases.service（删库时递归清目录），
 * 而且 API 进程和 worker 进程都要用（WorkerModule 直接 import 本模块）。
 * 逐个模块重复 import 只会增加装配噪音，没有任何隔离收益：本服务不含状态与权限判断，
 * 多模块共享同一实例正是想要的（同一个 root 路径、同一套路径校验）。
 *
 * 边界：这里只装配服务，不读配置、不建目录、不做健康检查；
 * 存储根目录由 StorageService 构造时向 AppConfigService 取 UPLOAD_DIR 并 resolve 成绝对路径。
 */
import { Global, Module } from '@nestjs/common';
import { StorageService } from './storage.service';

@Global()
@Module({
  providers: [StorageService],
  // 全局导出：别的模块无需 imports 本模块即可注入
  exports: [StorageService],
})
export class StorageModule {}
