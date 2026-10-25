/**
 * 数据库模块：注册连接池服务与仓储类，并整组导出。
 *
 * 职责边界：
 * - 只做依赖装配，不含任何 SQL 或业务规则
 * - 标了 @Global 并 exports 下列全部提供者，业务模块无需 import 本模块就能注入 DatabaseService 与这几个仓储
 * - 仓储清单在此集中维护：新增仓储必须同时加进下面的 repositories 数组，否则别的应用模块注入不到
 */
import { Global, Module } from '@nestjs/common';
import { AppConfigModule } from '../config/config.module';
import { DatabaseService } from './database.service';
import { UsersRepository } from './repositories/users.repository';
import { SessionsRepository } from './repositories/sessions.repository';
import { OrganizationsRepository } from './repositories/organizations.repository';
import { MembershipsRepository } from './repositories/memberships.repository';
import { InvitesRepository } from './repositories/invites.repository';

// 只列身份/组织相关的仓储：知识库、文档、对话等仓储由各自模块就近提供，避免全局模块承载全部数据访问
const repositories = [
  UsersRepository,
  SessionsRepository,
  OrganizationsRepository,
  MembershipsRepository,
  InvitesRepository,
];

@Global()
@Module({
  imports: [AppConfigModule],
  providers: [DatabaseService, ...repositories],
  exports: [DatabaseService, ...repositories],
})
export class DatabaseModule {}
