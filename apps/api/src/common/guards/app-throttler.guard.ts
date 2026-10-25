/**
 * 全局限流守卫：@nestjs/throttler 的 ThrottlerGuard 加一层「测试环境整体跳过」。
 * 在 AppModule 以 APP_GUARD 注册（排在 Origin 守卫之前：被限流挡掉的请求不再消耗 Origin 判断），
 * 默认额度由 ThrottlerModule.forRoot 定为 100 次/60 秒；各路由可用 @Throttle 覆盖，
 * 目前收紧的有三处：登录（5 次/分钟）与注册（10 次/小时）在 auth.controller.ts，
 * 邀请链接换详情（30 次/分钟）在 invites.controller.ts。
 * 失败返回：超额请求由父类抛 ThrottlerException(429)。
 * 为什么要跳过测试：test/setup-env.ts 把 NODE_ENV 置为 test，此守卫随之整体豁免。
 * e2e 会在极短时间内对同一套收紧过的路由批量发注册/登录请求，计数一旦生效，
 * 同一应用内按请求顺序累计到额度后就会稳定返回 429，测试结果就不再只由业务逻辑决定。
 * 边界：只决定「这个请求要不要豁免限流计数」，窗口与计数的算法全在父类，本文件不碰。
 */
import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  protected async shouldSkip(context: ExecutionContext): Promise<boolean> {
    // 测试环境无条件豁免；其余情况回退父类实现（父类默认返回 false，即一律参与限流计数，
    // @SkipThrottle 的豁免走的是父类 canActivate 里的另一条元数据路径，不经过这里）
    if (process.env.NODE_ENV === 'test') return true;
    return super.shouldSkip(context);
  }
}
