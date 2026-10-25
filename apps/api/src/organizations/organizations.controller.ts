/**
 * 组织 HTTP 控制器：/orgs 下的组织改名、成员管理与邀请管理，共 8 个路由。
 *
 * 守卫覆盖情况（别把「这个控制器挂了 OrgMemberGuard」读成「所有路由都挂了」）：
 * - POST /orgs（建组织）刻意不挂 OrgMemberGuard：此刻请求者还不是任何组织的成员，
 *   守卫只会把他判成 404；「他将成为 owner」这件事由 OrganizationsService.create 在 SQL 里写死。
 *   这条路由仍然有全局 AuthGuard（必须登录）+ OriginGuard + 全局限流兜着
 * - 其余 7 个路由逐个在方法上挂了 @UseGuards(OrgMemberGuard)：非该组织成员一律 404
 * - 本控制器没有任何「角色级」装饰器：owner/admin 的门槛全部写在服务方法的第一行，
 *   守卫只回答「是不是成员」并带出 role。所以读接口时务必跳到服务里看那句 role 判断
 * 各路由的实际门槛（逐条对应服务代码）：
 * - 改名 owner；改成员角色 owner；看成员列表 任何成员；移除成员 owner/admin（admin 不能动 admin）
 * - 看/发/撤邀请 admin 及以上，其中「发 admin 邀请」再收紧到 owner
 * 边界：控制器只做参数解析（ParseUUIDPipe 挡掉非 UUID 的 orgId/userId/inviteId）、
 * 用装饰器取出 user 与 membership，然后原样交给服务；不含业务分支，也不组装响应体。
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
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CurrentMembership, CurrentMembershipValue } from '../common/decorators/current-membership.decorator';
import { OrgMemberGuard } from '../common/guards/org-member.guard';
import { AuthUser, OrgSummary } from '../common/types';
import { OrganizationsService } from './organizations.service';
import { MembersService } from './members.service';
import { InvitesService } from './invites.service';
import { CreateOrgDto } from './dto/create-org.dto';
import { UpdateOrgDto } from './dto/update-org.dto';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto';
import { CreateInviteDto } from './dto/create-invite.dto';

@Controller('orgs')
export class OrganizationsController {
  constructor(
    private readonly organizations: OrganizationsService,
    private readonly members: MembersService,
    private readonly invites: InvitesService,
  ) {}

  /** 建组织：唯一不挂 OrgMemberGuard 的路由（见文件头），user.id 来自全局 AuthGuard 校验过的会话 */
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateOrgDto): Promise<OrgSummary> {
    return this.organizations.create(user.id, dto.name);
  }

  /** 改名：守卫确认成员身份，服务里再确认必须是 owner */
  @UseGuards(OrgMemberGuard)
  @Patch(':orgId')
  rename(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @CurrentMembership() membership: CurrentMembershipValue,
    @Body() dto: UpdateOrgDto,
  ) {
    return this.organizations.rename(orgId, membership, dto.name);
  }

  /** 成员列表：不设角色门槛，本组织任何成员都能看谁在、各是什么角色（排序在服务下面的仓储层） */
  @UseGuards(OrgMemberGuard)
  @Get(':orgId/members')
  listMembers(@Param('orgId', ParseUUIDPipe) orgId: string) {
    return this.members.list(orgId);
  }

  /** 改成员角色：owner 专属，且改不动 owner 那一行，规则见 MembersService.updateRole */
  @UseGuards(OrgMemberGuard)
  @Patch(':orgId/members/:userId')
  updateMemberRole(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentMembership() membership: CurrentMembershipValue,
    @Body() dto: UpdateMemberRoleDto,
  ) {
    return this.members.updateRole(orgId, membership, userId, dto.role);
  }

  /**
   * 移除成员：这条路由是「一个请求删三张表 + 广播权限回收事件」的入口，
   * 事务边界与清理范围都在 MembersService.remove 里（控制器不感知）
   */
  @UseGuards(OrgMemberGuard)
  @Delete(':orgId/members/:userId')
  removeMember(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentMembership() membership: CurrentMembershipValue,
  ) {
    return this.members.remove(orgId, membership, userId);
  }

  /** 邀请列表：admin 及以上；返回体不含可用令牌 */
  @UseGuards(OrgMemberGuard)
  @Get(':orgId/invites')
  listInvites(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @CurrentMembership() membership: CurrentMembershipValue,
  ) {
    return this.invites.list(orgId, membership);
  }

  /** 签发组织级邀请：member 拒绝，admin 只能邀 member，邀 admin 需 owner */
  @UseGuards(OrgMemberGuard)
  @Post(':orgId/invites')
  createInvite(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @CurrentMembership() membership: CurrentMembershipValue,
    @Body() dto: CreateInviteDto,
  ) {
    return this.invites.create(orgId, membership, dto.role);
  }

  /** 撤销邀请：admin 及以上，撤别人签发的也可以；删除按 org_id 限定，删不到别的组织的邀请 */
  @UseGuards(OrgMemberGuard)
  @Delete(':orgId/invites/:inviteId')
  revokeInvite(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('inviteId', ParseUUIDPipe) inviteId: string,
    @CurrentMembership() membership: CurrentMembershipValue,
  ) {
    return this.invites.revoke(orgId, membership, inviteId);
  }
}
