/**
 * 文档模块的依赖装配：一个控制器 + 一个服务 + 本模块专属的仓储 + 两个路由级守卫。
 *
 * 五个容易看漏的点：
 * 1. imports 里三者的必要性不同：DatabaseModule 与 StorageModule 都是 @Global 模块，
 *    写在这里只是把「本模块用了哪三层能力」声明清楚，删掉照样注入得到；
 *    KnowledgeBasesModule 不是 @Global，DocumentsService 注入的 KbAccessService 由它导出，
 *    这一行删掉应用会在实例化 DocumentsService 时报「没有提供者」
 * 2. 反过来，DocumentsService 还注入了 AppConfigService 与 QueueService，本模块却没 import
 *    AppConfigModule / QueueModule——因为它们本身就是 @Global，不需要显式声明
 * 3. DocumentsRepository 必须在这里自己提供：DatabaseModule 全局导出的仓储只有身份/组织那一组
 *    （users/sessions/organizations/memberships/invites），文档、知识库、对话这些仓储
 *    按「各模块就近提供」的约定放在各自模块里
 * 4. OrgMemberGuard 与 KbPermissionGuard 是路由级守卫（靠 @UseGuards 引用，不是 APP_GUARD），
 *    每个模块各持一份实例，所以这里不登记的话控制器里的 @UseGuards 会找不到 provider。
 *    它们真正生效的位置由控制器决定：本模块里只有 list 与 upload 两条路由过 KbPermissionGuard
 * 5. exports 两项目前没有模块外消费者（ingestion 直接写 SQL 并按 storageKey 读文件，
 *    不注入 DocumentsService），留着是给后续复用开的口子
 *
 * worker 进程不装本模块：入库链路不需要文档 HTTP 层，见 worker.module.ts 的取舍说明。
 */
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { StorageModule } from '../storage/storage.module';
import { KnowledgeBasesModule } from '../knowledge-bases/knowledge-bases.module';
import { OrgMemberGuard } from '../common/guards/org-member.guard';
import { KbPermissionGuard } from '../common/guards/kb-permission.guard';
import { DocumentsRepository } from '../database/repositories/documents.repository';
import { DocumentsService } from './documents.service';
import { DocumentsController } from './documents.controller';

@Module({
  // 连接池（Database）、落盘（Storage）、权限判定（KnowledgeBases）——三者必要性见文件头第 1、2 点
  imports: [DatabaseModule, StorageModule, KnowledgeBasesModule],
  controllers: [DocumentsController],
  providers: [
    // 仓储在此提供（不是全局那一批）
    DocumentsRepository,
    DocumentsService,
    // 路由级守卫：供控制器 @UseGuards 引用
    OrgMemberGuard,
    KbPermissionGuard,
  ],
  exports: [DocumentsService, DocumentsRepository],
})
export class DocumentsModule {}
