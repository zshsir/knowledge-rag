/**
 * 参数装饰器：把 request.kbPermission（KbPermissionGuard 解析并放行后写入的有效权限等级）注入入参。
 * 用途：目前唯一调用方是知识库详情接口（GET :kbId），把守卫解析出的等级传进 service，
 * 随返回体输出 effectivePermission，前端据此渲染「这个人实际能做什么」的按钮。
 * 取不到会怎样：只有「路由挂了 KbPermissionGuard 且带 @RequireKbPermission」守卫才会写这个字段；
 * 没挂守卫的接口在这里拿到的是 undefined，被 `!` 断言掩盖成 KbPermission。
 */
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthenticatedRequest, KbPermission } from '../types';

export const CurrentKbPermission = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): KbPermission => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    return request.kbPermission!;
  },
);
