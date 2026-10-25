/**
 * 认证模块：装配 /api/auth 一套（控制器 + 三个服务），并完成全局登录守卫的注册点。
 * 关键点：
 * - AuthGuard 以 APP_GUARD 挂在这里而不是 AppModule：守卫依赖 SessionService，
 *   谁提供依赖谁注册最顺；效果是登录校验对全应用所有 HTTP 路由生效，
 *   豁免通道是路由上的 @Public()（注册/登录、健康探针、邀请页共四处）
 * - exports 三件套里目前真正被外部消费的是 SessionService（realtime 网关用它做 WS 握手鉴权）；
 *   AuthService/PasswordService 暂无模块外调用方，留着导出是「认证能力的门面」
 * - 只 import DatabaseModule：仓储（users/sessions/organizations）都从那里来
 * 边界：组织内角色、知识库权限属于各自模块，本模块不参与。
 */
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { DatabaseModule } from '../database/database.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { SessionService } from './session.service';
import { AuthGuard } from '../common/guards/auth.guard';

@Module({
  imports: [DatabaseModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    SessionService,
    // 全局守卫：Nest 保证 APP_GUARD 先于控制器/路由级守卫执行，
    // 后面的 OrgMemberGuard/KbPermissionGuard 才能放心地读 request.user
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
  ],
  exports: [AuthService, PasswordService, SessionService],
})
export class AuthModule {}
