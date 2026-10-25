/**
 * 组织成员用例服务：列出成员、改成员角色、移除成员。
 *
 * 职责与边界：
 * - 「谁能对谁动角色、谁能移除谁」的全部判定都在这里。OrgMemberGuard 只确认操作者是本组织
 *   成员并把他的 role 挂上请求，不设角色门槛；MembershipsRepository 也刻意不校验资格（见其文件头）
 * - 写入范围：memberships、knowledge_base_members、conversations 三张表。
 *   不碰 users、不碰 sessions（被移除者的会话行留着，理由见 remove 的说明）、
 *   不碰知识库本体与文档，也不动 invites 里他当年签发的邀请
 * - 错误码分工是给前端的话术：403=没这个资格，400=这个操作本身不该做，404=目标不在这个组织里
 * - 全部校验都在写库之前完成：任何一条抛错的分支都不会留下半个改动
 */
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CurrentMembershipValue } from '../common/decorators/current-membership.decorator';
import { AccessEventsService } from '../common/events/access-events.service';
import { OrgRole } from '../common/types';
import { DatabaseService } from '../database/database.service';
import {
  MembershipsRepository,
  OrgMemberView,
} from '../database/repositories/memberships.repository';

/**
 * 角色规则表（两列门槛分别对应 updateRole 与 remove 的分支，逐条可在方法注释里对上代码）：
 *
 *              改别人角色 updateRole        移除别人 remove
 *  owner        可改 admin / member         可移除 admin 与 member（不能移除自己 → 400）
 *  admin        一律 403                    只可移除 member；移除同级 admin → 403
 *  member       一律 403                    一律 403
 *
 * 两条横切规则：
 * - owner 那一行谁都动不了：updateRole 与 remove 都在资格校验之后额外按 target.role==='owner' 拒绝，
 *   所以 owner 既不会被降级也不会被移出组织，走本服务不可能把组织弄成没有 owner 的状态
 * - 目标必须在 orgId 下有 memberships 行，否则 404（不区分「从没加入过」与「已被别人移走」）
 * 成员列表则不设角色门槛：任何本组织成员都能看（list 不再自查 role）
 */
@Injectable()
export class MembersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly memberships: MembershipsRepository,
    private readonly accessEvents: AccessEventsService,
  ) {}

  /** 列出本组织全体成员：排序（owner→admin→member）与列名转换都在 MembershipsRepository.list 里 */
  list(orgId: string): Promise<OrgMemberView[]> {
    return this.memberships.list(orgId);
  }

  /**
   * 改成员角色。步骤：
   * 1. 资格：只有 owner 能改（actor.role!=='owner' → 403）——admin 在这里就被挡下，
   *    管理员能移人却不能改角色，两条接口的门槛并不对称
   * 2. 目标必须是本组织成员，否则 404
   * 3. 目标是 owner → 403：owner 不可被降级。配合 remove 里对 target.role==='owner' 的同类拒绝，
   *    走这两个接口都不可能让组织失去 owner
   * 4. 写回 memberships.role（UpdateMemberRoleDto 把入参限死在 admin/member，
   *    所以这条路径既造不出第二个 owner，也不会写出 owner 之外的非法值）
   * 注：owner 改自己的角色也会被第 3 步拒掉（他就是 owner），不需要额外的「不能改自己」判断
   */
  async updateRole(
    orgId: string,
    actor: CurrentMembershipValue,
    targetUserId: string,
    role: 'admin' | 'member',
  ): Promise<{ ok: true }> {
    if (actor.role !== 'owner') {
      throw new ForbiddenException('仅所有者可以修改成员角色');
    }
    const target = await this.memberships.find(orgId, targetUserId);
    if (!target) throw new NotFoundException('成员不存在');
    if (target.role === 'owner') {
      throw new ForbiddenException('不能修改所有者角色');
    }
    await this.memberships.updateRole(orgId, targetUserId, role);
    return { ok: true };
  }

  /**
   * 移除成员：四条校验全过之后，一个事务清干净他在本组织的痕迹，提交后再通知在线连接。
   *
   * 步骤：
   * 1. 资格：member 一律 403；owner 可移 admin/member，admin 只可移 member（同级互斥 403）
   * 2. 四道拒绝，顺序即代码顺序：不能移自己 → 400；必须在本组织 → 404；owner 动不了 → 403；
   *    admin 之间互斥 → 403
   * 3. 事务内按顺序删三样：本组织全部知识库对这个用户的显式授权行、他在本组织里的对话记录
   *    （messages 由 conversations 的 FK ON DELETE CASCADE 连带删掉）、成员关系本身
   *    授权行没有 org_id 列，删除范围只能靠「kb_id 属于本组织的库」这个子查询限定；
   *    事务开头那次 SELECT 取的就是这份库 id 列表，事务结束后直接拿来定第 4 步的广播目标
   * 4. 事务提交成功后逐库 emit 权限回收事件（reason:'org-member-removed'），实时网关据此
   *    把他从 kb:<id> 房间移出并推 'kb:access-revoked'
   *
   * 为什么第 3 步不能只删 memberships：
   * - knowledge_base_members 表没有 org_id 列，删成员关系不会连带删掉授权行；不一起删就会留下
   *   「已无组织身份但仍有 kb 授权行」的脏状态——他确实读不到数据（解析有效权限时非成员这条前置
   *   检查先返回 null），但知识库成员列表是按 kb_id JOIN users 出来的，他会一直挂在别人的成员列表里
   * - 对话记录（conversations）是按 (org_id, user_id) 这对条件查的（见 chat.service 与
   *   ConversationsRepository），人一旦不属于这个组织，这些行既查不出来也删不掉——
   *   问答接口全在组织作用域里。这里选择把它们一起删掉，效果是这个人日后重新加入该组织时
   *   也看不到这些历史对话
   * - 已建立的 WebSocket 连接不会因为一次 DELETE 断开：他会继续留在 kb 房间里收到该库的
   *   document:status 推送（documentId、status、chunkCount、error 这几个字段），
   *   所以要靠第 4 步当场把他踢出房间
   *
   * 如实说明两点：
   * - 本方法不删 sessions 表的登录会话（会话删除只有登出与改密两条路径，见 auth/session.service.ts）。
   *   被移除者的 Cookie 仍然能通过全局 AuthGuard，但已经进不了这个组织的任何数据：组织作用域路由
   *   每次请求都要重过 OrgMemberGuard，成员行已删即 404；知识库级判定也会在「非成员」这条前置检查上
   *   返回 null。真正还能访问的只剩不依赖 orgId 的接口：/auth/me、/auth/logout、/auth/password、
   *   /health，以及 /invites 下的两条（也就是说拿一条新邀请可以重新加入该组织）
   * - 第 4 步按「本组织的全部知识库」逐条发事件，不筛该用户实际有权限的那几个；对无权限的库而言
   *   这条事件只是空操作（他本来不在那个房间）。事件本身是进程内内存总线，丢了不补，兜底仍是上面
   *   说的每请求重判
   */
  async remove(
    orgId: string,
    actor: CurrentMembershipValue,
    targetUserId: string,
  ): Promise<{ ok: true }> {
    // 步骤 1：谁能移人——owner 与 admin，member 到此为止
    if (actor.role === 'member') {
      throw new ForbiddenException('没有移除成员的权限');
    }
    // 步骤 2：三条目标校验（最后一条是 admin 的同级互斥），全部先于任何写入
    if (actor.userId === targetUserId) {
      throw new BadRequestException('不能移除自己');
    }
    const target = await this.memberships.find(orgId, targetUserId);
    if (!target) throw new NotFoundException('成员不存在');
    if (target.role === 'owner') {
      // 组织不允许没有 owner，也不允许 owner 主动甩锅离开
      throw new ForbiddenException('不能移除所有者');
    }
    if (actor.role === 'admin' && target.role === 'admin') {
      throw new ForbiddenException('管理员不能移除管理员');
    }

    // 步骤 3：一个事务里删授权行、对话记录、成员关系；三样必须同生同死，
    // 只删掉一半就会出现「人走了权限还留着」或「人还在组织但对话没了」
    const kbIds = await this.db.withTransaction(async (client) => {
      // 先取本组织全部知识库 id：这份列表在事务提交后直接成为步骤 4 的广播目标
      // （下面 DELETE 的删除范围由它自己的同款子查询独立限定，两者互不依赖）
      const kbs = await client.query<{ id: string }>(
        'SELECT id FROM knowledge_bases WHERE org_id = $1',
        [orgId],
      );
      await client.query(
        `DELETE FROM knowledge_base_members
         WHERE user_id = $1 AND kb_id IN (SELECT id FROM knowledge_bases WHERE org_id = $2)`,
        [targetUserId, orgId],
      );
      await client.query(
        'DELETE FROM conversations WHERE user_id = $1 AND org_id = $2',
        [targetUserId, orgId],
      );
      await client.query(
        'DELETE FROM memberships WHERE org_id = $1 AND user_id = $2',
        [orgId, targetUserId],
      );
      return kbs.rows.map((row) => row.id);
    });

    // 步骤 4：事务已提交才广播——反过来会出现「人已被踢出房间、库里其实还是成员」的误导
    for (const kbId of kbIds) {
      this.accessEvents.emit({
        userIds: [targetUserId],
        kbId,
        reason: 'org-member-removed',
      });
    }
    return { ok: true };
  }
}
