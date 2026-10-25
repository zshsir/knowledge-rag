/**
 * 配置模块：把 .env 里的环境变量读进来，并对外只暴露一个 AppConfigService。
 *
 * 职责边界：
 * - 只负责「装配」@nestjs/config 的 ConfigModule 并把 AppConfigService 注册为提供者，不做任何校验/读取逻辑
 * - 标了 @Global，所以业务模块不用 import 本模块就能注入 AppConfigService，减少每个模块的样板 import
 * - 不关心具体有哪些配置项，字段定义与默认值全在 config.service.ts
 */
import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { join } from 'node:path';
import { AppConfigService } from './config.service';

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // 两个候选路径按顺序尝试：apps/api/.env（本地分环境配置）优先于仓库根 .env（全家共享一份密钥）
      // 本地开发一般在根放 .env，所以根路径是兜底；容器里由 compose 注入真实环境变量，两条都读不到也无妨
      envFilePath: [
        join(process.cwd(), '.env'),
        join(process.cwd(), '../../.env'),
      ],
    }),
  ],
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class AppConfigModule {}
