/**
 * 路由元数据装饰器：把「这个接口不需要登录」写进 handler/class 的元数据，
 * 供全局 AuthGuard 用 Reflector.getAllAndOverride 读取（handler 优先于 class）。
 * 当前用在四处：auth 的注册与登录、health 探针、邀请链接换取详情；
 * 注意它只豁免 AuthGuard——Origin 守卫与限流守卫照常生效。
 */
import { SetMetadata } from '@nestjs/common';

/** 元数据键：AuthGuard 与 @Public() 之间的唯一契约，两边都通过它读写 */
export const IS_PUBLIC_KEY = 'isPublic';
/** 使用方式：@Public()，置 true 即豁免登录校验；没有「设为 false」的用法，不贴就是需要登录 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
