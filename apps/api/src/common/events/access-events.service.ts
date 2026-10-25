/**
 * 「权限被回收」事件的进程内发布/订阅总线：一个 RxJS Subject 而已。
 * 生产端：知识库移成员（kb-member-removed）、库改为 restricted 模式（kb-restricted）、
 * 组织移除成员（org-member-removed）三处业务在改库成功后 emit 一条事件。
 * 消费端：目前只有 realtime 网关订阅——把用户踢出对应 socket 房间并推 'kb:access-revoked'，
 * 让前端立刻刷新可见知识库。
 * 边界（都是本实现的如实描述）：
 * - 内存态、同步派发：不持久化、不重发；订阅者晚于 emit 启动就错过该事件
 * - 单进程内有效：多实例部署时各实例各发各的，不会跨实例广播
 * - 只负责「通知」，不负责「执行」：授权数据由各服务在 emit 之前已删/已改；
 *   就算这条事件丢了，兜底仍是每次请求时守卫的重新判定——事件只影响前端刷新的及时性，
 *   不影响真实权限。也不删会话行（被移出组织的人 Cookie 仍然有效、仍能通过 AuthGuard）：
 *   兜底只覆盖组织/知识库作用域的路由——这类路由每次请求都会被 OrgMemberGuard/KbPermissionGuard
 *   判成 404；不带组织作用域的路由（如 /auth/me、/auth/logout、/health）仍回 200，
 *   只是可见组织列表变空。详见 session.service.ts 与 org-member.guard.ts 的边界说明。
 */
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Subject } from 'rxjs';

/** 一次权限回收的载荷：涉及哪些用户、哪个库、因为什么 */
export interface AccessRevocation {
  userIds: string[];
  kbId: string;
  // 三种回收场景：被移出知识库授权列表 / 知识库切换为 restricted / 被移出整个组织
  reason: 'kb-member-removed' | 'kb-restricted' | 'org-member-removed';
}

@Injectable()
export class AccessEventsService implements OnModuleDestroy {
  private readonly subject = new Subject<AccessRevocation>();
  /** 对外只暴露只读流，emit 是本服务唯一的写入口 */
  readonly revocations$ = this.subject.asObservable();

  /** 同步把事件推给当前所有订阅者；无订阅者时等于丢弃，不报错也不补发 */
  emit(revocation: AccessRevocation) {
    this.subject.next(revocation);
  }

  // 应用关闭时结束事件流；订阅方各自收尾（实时网关持有 Subscription，在它的 onModuleDestroy 里 unsubscribe）
  onModuleDestroy() {
    this.subject.complete();
  }
}
