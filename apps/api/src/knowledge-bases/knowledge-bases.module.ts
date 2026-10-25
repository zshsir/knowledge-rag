/**
 * 知识库模块的装配：库本体/成员/权限判定三个服务 + 本模块用到的两个路由级守卫。
 *
 * 装配要点：
 * - providers 里额外登记 OrgMemberGuard 与 KbPermissionGuard：路由级守卫必须在所在模块注册才能
 *   被 @UseGuards 解析，且 KbPermissionGuard 要注入 Reflector 与 KbAccessService（本模块提供）。
 *   这与 app.module 里以 APP_GUARD 注册的 AppThrottlerGuard/OriginGuard、auth.module 里注册的
 *   AuthGuard 是两种注册方式；documents/chat 两个模块也各自重复登记了这两个守卫，
 *   每个模块拿到的是自己实例，不是同一个单例
 * - imports 里的 DatabaseModule、AccessEventsModule、StorageModule 都是 @Global 模块，
 *   写出来只是把依赖声明清楚，不写也能注入到 DatabaseService、事件总线与 StorageService
 *   （删库要递归清该库的上传目录，用的是 StorageService.removeKbDir）
 * - OrganizationsModule 只为拿 InvitesService（按邮箱加人遇到查无此人时签发知识库作用域邀请）。
 *   依赖是单向的：organizations 不依赖本模块，因此没有循环、不需要 forwardRef
 * - exports 六项里目前只有 KbAccessService 有跨模块消费者：documents、chat、realtime 都 import
 *   本模块并调它的 require；KnowledgeBasesService、KbMembersService 与三个仓储
 *   在当前代码里没有模块外的调用方
 * - worker.module.ts 刻意不导入本模块：入库进程不需要 HTTP 守卫链，也用不到这些控制器
 */
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AccessEventsModule } from '../common/events/access-events.module';
import { StorageModule } from '../storage/storage.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { OrgMemberGuard } from '../common/guards/org-member.guard';
import { KbPermissionGuard } from '../common/guards/kb-permission.guard';
import { KbAccessRepository } from '../database/repositories/kb-access.repository';
import { KnowledgeBasesRepository } from '../database/repositories/knowledge-bases.repository';
import { KbMembersRepository } from '../database/repositories/kb-members.repository';
import { KbAccessService } from './kb-access.service';
import { KnowledgeBasesService } from './knowledge-bases.service';
import { KbMembersService } from './kb-members.service';
import { KnowledgeBasesController } from './knowledge-bases.controller';

@Module({
  imports: [DatabaseModule, AccessEventsModule, StorageModule, OrganizationsModule],
  controllers: [KnowledgeBasesController],
  providers: [
    KbAccessRepository,
    KnowledgeBasesRepository,
    KbMembersRepository,
    KbAccessService,
    KnowledgeBasesService,
    KbMembersService,
    KbPermissionGuard,
    OrgMemberGuard,
  ],
  exports: [
    KbAccessService,
    KnowledgeBasesService,
    KbMembersService,
    KbAccessRepository,
    KnowledgeBasesRepository,
    KbMembersRepository,
  ],
})
export class KnowledgeBasesModule {}
