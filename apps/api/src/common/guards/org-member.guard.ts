/**
 * 组织成员守卫：确认「已登录的这个人」是路由参数所指组织的成员，并把成员记录挂上请求。
 * 拦什么：未登录（401）、orgId 缺失或该用户不在此组织（404）。
 * 步骤：
 * 1. 要求 request.user 已由全局 AuthGuard 填好（本守卫是控制器/路由级，排在 APP_GUARD 之后）
 * 2. 从路由参数取 orgId；缺失 → 404「组织不存在」
 * 3. MembershipsRepository.find 按 (orgId, userId) 单行查询；查不到 → 404「组织不存在或无权访问」
 *    ——故意用 404 而不是 403：对非成员不承认这个组织存在，防止用状态码枚举组织 id
 * 4. 命中后把 { orgId, userId, role } 挂到 request.membership，供 @CurrentMembership() 与
 *    控制器内的角色判断（如「仅 owner/admin 可操作」）读取
 * 边界：只确认成员资格并带出角色，本身不区分 owner/admin/member 设门槛——门槛由各控制器自查
 * membership.role。也不做知识库级判定，那是 KbPermissionGuard 的事（它有自己的解析路径，
 * 不依赖本守卫先跑）。
 */
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { MembershipsRepository } from '../../database/repositories/memberships.repository';
import { AuthenticatedRequest } from '../types';

@Injectable()
export class OrgMemberGuard implements CanActivate {
  constructor(private readonly memberships: MembershipsRepository) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // 步骤 1：登录身份由全局 AuthGuard 注入；裸用本守卫拿不到 user 只会 401
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.user) throw new UnauthorizedException('请先登录');

    // 步骤 2：orgId 只能来自路由参数 :orgId，没有就当作访问不存在的组织
    const orgId = (request as unknown as { params: { orgId?: string } }).params
      ?.orgId;
    if (!orgId) throw new NotFoundException('组织不存在');

    // 步骤 3~4：查成员关系，命中即挂上 membership，未命中一律 404
    const membership = await this.memberships.find(orgId, request.user.id);
    if (!membership) throw new NotFoundException('组织不存在或无权访问');
    request.membership = membership;
    return true;
  }
}
