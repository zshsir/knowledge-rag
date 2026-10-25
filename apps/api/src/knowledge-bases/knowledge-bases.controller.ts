/**
 * 知识库 HTTP 控制器：/orgs/:orgId/knowledge-bases 下 9 个路由——库本体 5 个 + 成员授权 4 个。
 *
 * 守卫是两层的，覆盖范围不一样（读接口权限时务必分清）：
 * - 类级 @UseGuards(OrgMemberGuard)：9 个路由全部先要求「请求者属于 :orgId」，非成员一律 404
 * - 方法级 @UseGuards(KbPermissionGuard) + @RequireKbPermission(...)：只挂在带 :kbId 的 7 个路由上。
 *   GET /（列表）与 POST /（新建）刻意不挂——列表没有单个 kbId，按可见性在 SQL 与服务层筛；
 *   新建此刻还没有库可判，任何组织成员都能建库
 *   所以「每个知识库路由都配了 KbPermissionGuard」这句话只对带 :kbId 的路由成立
 * 门槛分布：详情 = viewer；改设置、删库、列成员、加成员、改权限、撤权限 = manager。
 * 未挂 @RequireKbPermission 的守卫等于不做任何事（见 kb-permission.guard.ts 步骤 1），
 * 所以装饰器和 UseGuards 必须成对出现，少一个就是静默放行。
 *
 * 两个守卫对「非成员」都会拒绝，只是文案不同（404「组织不存在或无权访问」 vs
 * 404「知识库不存在或无权访问」），Nest 的守卫合并顺序不影响对外结果，本控制器不依赖它们的先后。
 * 边界：控制器只做 ParseUUIDPipe 参数校验、用装饰器取 user/membership/有效权限，
 * 然后原样交给服务；角色细节（谁能删库、被授权的 manager 为什么不行）都在服务层。
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentKbPermission } from '../common/decorators/current-kb-permission.decorator';
import { CurrentMembership, CurrentMembershipValue } from '../common/decorators/current-membership.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequireKbPermission } from '../common/decorators/require-kb-permission.decorator';
import { KbPermissionGuard } from '../common/guards/kb-permission.guard';
import { OrgMemberGuard } from '../common/guards/org-member.guard';
import { AuthUser, KbPermission } from '../common/types';
import { KnowledgeBasesService } from './knowledge-bases.service';
import { KbMembersService } from './kb-members.service';
import { CreateKbDto } from './dto/create-kb.dto';
import { UpdateKbDto } from './dto/update-kb.dto';
import { AddKbMemberDto } from './dto/add-kb-member.dto';
import { UpdateKbMemberDto } from './dto/update-kb-member.dto';

@UseGuards(OrgMemberGuard)
@Controller('orgs/:orgId/knowledge-bases')
export class KnowledgeBasesController {
  constructor(
    private readonly knowledgeBases: KnowledgeBasesService,
    private readonly kbMembers: KbMembersService,
  ) {}

  /**
   * 列表：只有 OrgMemberGuard，没有 KbPermissionGuard（无 kbId 可判）。
   * 可见性由 SQL 筛、有效权限由服务层逐行算，membership.role 是穿透判定的输入
   */
  @Get()
  list(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @CurrentUser() user: AuthUser,
    @CurrentMembership() membership: CurrentMembershipValue,
  ) {
    return this.knowledgeBases.list(orgId, user.id, membership.role);
  }

  /** 新建：组织成员即可建库，created_by 写他本人，于是他对自己建的库天生是 manager */
  @Post()
  create(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateKbDto,
  ) {
    return this.knowledgeBases.create(orgId, user.id, dto);
  }

  /**
   * 详情：门槛 viewer。这是全项目唯一一处消费 @CurrentKbPermission() 的地方——
   * 守卫解析出的等级直接传给服务，服务不再重复判定
   */
  @UseGuards(KbPermissionGuard)
  @RequireKbPermission('viewer')
  @Get(':kbId')
  get(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('kbId', ParseUUIDPipe) kbId: string,
    @CurrentKbPermission() permission: KbPermission,
  ) {
    return this.knowledgeBases.get(orgId, kbId, permission);
  }

  /** 改设置（含 access_mode 切换）：manager。切到 restricted 时的权限回收广播在服务层 */
  @UseGuards(KbPermissionGuard)
  @RequireKbPermission('manager')
  @Patch(':kbId')
  update(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('kbId', ParseUUIDPipe) kbId: string,
    @CurrentMembership() membership: CurrentMembershipValue,
    @Body() dto: UpdateKbDto,
  ) {
    return this.knowledgeBases.update(orgId, kbId, membership, dto);
  }

  /**
   * 删库：门槛 manager，服务层还会再看一次组织角色/创建者身份——
   * 被单独授权成 manager 的普通成员过不了那一道（KnowledgeBasesService.remove 步骤 2）
   */
  @UseGuards(KbPermissionGuard)
  @RequireKbPermission('manager')
  @Delete(':kbId')
  remove(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('kbId', ParseUUIDPipe) kbId: string,
    @CurrentUser() user: AuthUser,
    @CurrentMembership() membership: CurrentMembershipValue,
  ) {
    return this.knowledgeBases.remove(orgId, kbId, user, membership);
  }

  /** 成员列表：manager（看权限列表本身就被视为管理动作，viewer/editor 拿不到） */
  @UseGuards(KbPermissionGuard)
  @RequireKbPermission('manager')
  @Get(':kbId/members')
  listMembers(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('kbId', ParseUUIDPipe) kbId: string,
  ) {
    return this.kbMembers.list(orgId, kbId);
  }

  /**
   * 加成员：manager。三种结果由服务层的三条分支决定——
   * 直接授权 / 先补组织成员关系再授权 / 邮箱查无此人时只回一条邀请链接
   */
  @UseGuards(KbPermissionGuard)
  @RequireKbPermission('manager')
  @Post(':kbId/members')
  addMember(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('kbId', ParseUUIDPipe) kbId: string,
    @CurrentMembership() membership: CurrentMembershipValue,
    @Body() dto: AddKbMemberDto,
  ) {
    return this.kbMembers.add(orgId, kbId, membership, dto);
  }

  /**
   * 改某条显式授权的权限等级：manager。
   * 注意这个 handler 没有取 :orgId——org 边界由守卫用路由参数里的 orgId 校验过，
   * 服务层只按 kb_id+user_id 定位（见 KbMembersService.update 的说明）
   */
  @UseGuards(KbPermissionGuard)
  @RequireKbPermission('manager')
  @Patch(':kbId/members/:userId')
  updateMember(
    @Param('kbId', ParseUUIDPipe) kbId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateKbMemberDto,
  ) {
    return this.kbMembers.update(kbId, userId, dto.permission, user.id);
  }

  /** 撤某条显式授权：manager；库是 restricted 时服务层会广播权限回收事件 */
  @UseGuards(KbPermissionGuard)
  @RequireKbPermission('manager')
  @Delete(':kbId/members/:userId')
  removeMember(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('kbId', ParseUUIDPipe) kbId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.kbMembers.remove(orgId, kbId, userId);
  }
}
