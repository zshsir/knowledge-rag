/**
 * 路由元数据装饰器：声明「这个接口至少需要什么等级的知识库权限」，供 KbPermissionGuard 读取门槛。
 * 步骤：
 * 1. @RequireKbPermission('editor') 把等级写进 handler 元数据（key = REQUIRE_KB_PERMISSION_KEY）
 * 2. 守卫执行时按 handler → class 顺序取门槛：没声明的路由，即使挂了守卫也直接放行
 * 边界：装饰器本身零校验逻辑，只写元数据；等级高低的比较在守卫的 RANK 表里。
 */
import { SetMetadata } from '@nestjs/common';
import { KbPermission } from '../types';

/** 元数据键：装饰器与 KbPermissionGuard 之间的唯一契约 */
export const REQUIRE_KB_PERMISSION_KEY = 'requireKbPermission';
/** 声明路由的最低权限门槛，viewer < editor < manager（排序表见 kb-permission.guard 的 RANK） */
export const RequireKbPermission = (permission: KbPermission) =>
  SetMetadata(REQUIRE_KB_PERMISSION_KEY, permission);
