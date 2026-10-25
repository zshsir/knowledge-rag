/**
 * 组织模块的装配：两个控制器（/orgs 与 /invites）+ 三个服务 + 一个路由级守卫。
 *
 * 装配要点：
 * - imports 里的 DatabaseModule 与 AccessEventsModule 都是 @Global 模块（见各自文件头），
 *   这里显式写出来只是声明依赖，不写也能注入到 DatabaseService 与那些身份/组织仓储
 * - OrgMemberGuard 登记在本模块 providers：它是路由级守卫，要注入 MembershipsRepository，
 *   由控制器上的 @UseGuards(OrgMemberGuard) 引用；这与 app.module 里以 APP_GUARD 注册的
 *   AppThrottlerGuard/OriginGuard、auth.module 里注册的 AuthGuard 是两种注册方式
 * - exports 三项里目前只有 InvitesService 有跨模块消费者：KnowledgeBasesModule 导入本模块，
 *   在 KbMembersService.add 遇到「邮箱查无此人」时调 createForKb 签发知识库作用域邀请。
 *   OrganizationsService 与 MembersService 只被本模块的 OrganizationsController 使用
 * - 依赖方向是单向的：organizations → 不依赖任何业务模块；knowledge-bases → 依赖本模块。
 *   没有循环，所以不需要 forwardRef
 */
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AccessEventsModule } from '../common/events/access-events.module';
import { OrgMemberGuard } from '../common/guards/org-member.guard';
import { OrganizationsController } from './organizations.controller';
import { InvitesController } from './invites.controller';
import { OrganizationsService } from './organizations.service';
import { MembersService } from './members.service';
import { InvitesService } from './invites.service';

@Module({
  imports: [DatabaseModule, AccessEventsModule],
  controllers: [OrganizationsController, InvitesController],
  providers: [
    OrganizationsService,
    MembersService,
    InvitesService,
    OrgMemberGuard,
  ],
  exports: [OrganizationsService, MembersService, InvitesService],
})
export class OrganizationsModule {}
