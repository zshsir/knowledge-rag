/**
 * 参数装饰器：把 request.membership（OrgMemberGuard 查库命中后挂上的「我在该组织的成员记录」）注入入参。
 * 值来源：memberships 表按 (orgId, userId) 单行查询，含 orgId/userId/role 三个字段。
 * 取不到会怎样：路由没挂 OrgMemberGuard、或挂了但 orgId 与当前用户无关时，
 * 守卫已经先抛 404 拦下了，能走到控制器说明记录必然存在；
 * 真正的风险是「忘挂守卫还用它」——运行时 undefined，被 `!` 断言掩盖。
 */
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthenticatedRequest, OrgRole } from '../types';

/** 当前用户在该组织内的成员身份快照 */
export interface CurrentMembershipValue {
  orgId: string;
  userId: string;
  role: OrgRole;
}

export const CurrentMembership = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): CurrentMembershipValue => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    return request.membership!;
  },
);
