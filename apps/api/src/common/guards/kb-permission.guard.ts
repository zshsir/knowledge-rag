/**
 * 知识库权限守卫：解析当前用户对该知识库的有效权限，并校验是否达到接口要求的等级。
 * 拦什么：权限不足（403）、库不存在或无访问资格（404）；放行条件是路由压根没声明门槛。
 * 步骤：
 * 1. 读 @RequireKbPermission() 声明的门槛；未声明时直接放行——所以「挂了守卫但没贴装饰器」
 *    等于这个守卫对该路由不做任何事
 * 2. 要求 request.user 已由全局 AuthGuard 填好（本守卫是路由级，执行顺序在 APP_GUARD 之后），
 *    没有则 401；再从路由参数取 orgId/kbId，任一缺失 → 404「知识库不存在」
 * 3. 交 KbAccessService.resolve 解析有效权限，规则依次为：组织 owner/admin 穿透为 manager →
 *    库创建者 manager → knowledge_base_members 显式授权 → accessMode='org' 时全组织成员视为 viewer，
 *    都不命中（含非组织成员）解析结果为 null → 404「知识库不存在或无权访问」（用 404 而非 403，
 *    不向圈外人承认这个库存在）
 * 4. 用 RANK 表比等级：解析出的权限低于门槛 → 403「没有执行此操作的权限」
 * 5. 通过后把有效权限挂到 request.kbPermission，供 @CurrentKbPermission() 读取
 *    （注意：是校验通过后才挂，校验失败的请求在 request 上留不下这个字段）
 * 边界：只判定权限，不做任何数据读写。
 */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { KbPermission } from '../types';
import { AuthenticatedRequest } from '../types';
import { REQUIRE_KB_PERMISSION_KEY } from '../decorators/require-kb-permission.decorator';
import { KbAccessService } from '../../knowledge-bases/kb-access.service';

/** 权限等级排序表：viewer=1 < editor=2 < manager=3，比较时只认这张表 */
const RANK: Record<KbPermission, number> = {
  viewer: 1,
  editor: 2,
  manager: 3,
};

@Injectable()
export class KbPermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly kbAccess: KbAccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // 步骤 1：门槛来自 @RequireKbPermission()，handler 优先于 class；没声明就放行
    const required = this.reflector.getAllAndOverride<KbPermission>(
      REQUIRE_KB_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required) return true;

    // 步骤 2：orgId/kbId 从路由参数取；参数缺失按「库不存在」处理，避免暴露路由形状
    const request = context.switchToHttp().getRequest<
      AuthenticatedRequest & { params: { orgId?: string; kbId?: string } }
    >();
    if (!request.user) throw new UnauthorizedException('请先登录');
    const { orgId, kbId } = request.params;
    if (!orgId || !kbId) throw new NotFoundException('知识库不存在');

    // 步骤 3：解析有效权限（穿透规则见文件头），解析不出 = 无权，一律 404
    const permission = await this.kbAccess.resolve(orgId, kbId, request.user.id);
    if (!permission) throw new NotFoundException('知识库不存在或无权访问');
    // 步骤 4：等级不够就 403——能走到这里说明库对他是存在的，才允许承认「存在但没权限」
    if (RANK[permission] < RANK[required]) {
      throw new ForbiddenException('没有执行此操作的权限');
    }
    // 步骤 5：挂上有效权限，控制器可用 @CurrentKbPermission() 取
    request.kbPermission = permission;
    return true;
  }
}
