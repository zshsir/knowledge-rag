/**
 * 知识库成员（显式授权）用例服务：列成员、加成员或发邀请、改权限、撤授权。
 *
 * 职责与边界：
 * - 只写 knowledge_base_members 这张「显式授权」表。组织 owner/admin 与库创建者的 manager
 *   不在这张表里（由 KbAccessService.resolve 推导），本服务既改不动也撤不掉它们——
 *   add 里对创建者和 owner/admin 直接 400，就是这条规则在接口层的落地
 * - 权限门槛全在控制器的 @RequireKbPermission('manager')，本文件不重复判角色，
 *   只判「这个人是什么身份，值不值得写一行授权」
 * - 与组织的两条联动：
 *   1) 直接给 userId 时，先确认他已经是本组织成员，否则 404「该用户不在组织中」——
 *      非成员过不了 resolve 的第一条前置检查，写授权行只会污染成员列表；
 *      不存在的 UUID 同样查不到成员关系，所以也停在 404，不会落到 user_id 外键上
 *   2) 按邮箱加一个已注册但不在本组织的人时，先把他拉进组织当 member，再写授权。
 *      必须先有组织成员身份，是因为 resolve 的第一条前置检查就是「非本组织成员直接 null」，
 *      给圈外人写一行 knowledge_base_members 也不会让他真的能访问这个库
 * - 不碰文档、不碰会话：撤掉一个人的授权不会删掉他在这个库里的历史对话
 * - 本表没有 org_id 列，租户边界由 kb_id 承载，所以每个方法都先按 (orgId, kbId) 或
 *   依赖守卫已经校验过这层归属
 */
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AccessEventsService } from '../common/events/access-events.service';
import { CurrentMembershipValue } from '../common/decorators/current-membership.decorator';
import { MembershipsRepository } from '../database/repositories/memberships.repository';
import { UsersRepository } from '../database/repositories/users.repository';
import { KbAccessRepository } from '../database/repositories/kb-access.repository';
import { KbMembersRepository } from '../database/repositories/kb-members.repository';
import { KnowledgeBasesRepository } from '../database/repositories/knowledge-bases.repository';
import { InvitesService } from '../organizations/invites.service';
import { AddKbMemberDto } from './dto/add-kb-member.dto';

@Injectable()
export class KbMembersService {
  constructor(
    private readonly kbRepo: KnowledgeBasesRepository,
    private readonly kbMembers: KbMembersRepository,
    private readonly kbAccessRepo: KbAccessRepository,
    private readonly memberships: MembershipsRepository,
    private readonly users: UsersRepository,
    private readonly invites: InvitesService,
    private readonly accessEvents: AccessEventsService,
  ) {}

  /**
   * 成员列表分两组返回，前端据此决定某一行能不能被删：
   * - members：真正写在 knowledge_base_members 里的显式授权（可改可撤）
   * - inherited：推导出来的 manager（组织 owner/admin + 库创建者），它们不是表里的行，
   *   撤掉它们只能改组织角色或换创建者
   * 两条查询互不依赖，用 Promise.all 并发发出，各自带 org 边界（listExplicit 靠 kb_id，
   * listInherited 靠 org_id）。
   */
  async list(orgId: string, kbId: string) {
    const [members, inherited] = await Promise.all([
      this.kbMembers.listExplicit(kbId),
      this.kbMembers.listInherited(orgId, kbId),
    ]);
    return { members, inherited };
  }

  /**
   * 加成员，必要时改成发邀请。三条分支按「先看 userId，再看 email，邮箱查无此人就发链接」排列：
   * 步骤：
   * 1. findById(orgId, kbId) 确认库在这个组织下，拿不到 → 404「知识库不存在」
   *    （kb_id 是本表的租户边界，这一步不能省，否则就等于拿别人的 kbId 往里写授权）
   * 2. 分支 A：dto.userId 有值 → 先 isMember(orgId, userId) 复核组织归属，
 *    不是本组织成员（含不存在的账号）→ 404「该用户不在组织中」；通过后把它当作被授权人，
 *    跳过所有邮箱处理
   * 3. 分支 B：只给了 email → trim+小写后按邮箱查 users：
   *    B1 查到账号：先确保他是本组织成员，不是就用 memberships.create 拉进来当 member
   *       （ON CONFLICT DO NOTHING 兜住并发重复），然后落到共同的授权步骤；
   *       这一步不等对方点链接——只有对该库是 manager 的人才触发得动
   *    B2 查不到账号：交 InvitesService.createForKb 签一条知识库作用域的一次性链接
   *       （组织角色固定 member，附带本库的权限），立刻 return { invited: true, invite }，
   *       此时一行授权都不写；等对方注册/登录后接受邀请，才由 accept 的第 5 步写入
   * 4. 两个字段都没给 → 400「请提供成员 ID 或邮箱」
   * 5. 两条身份排除：库创建者 → 400「创建者已拥有管理权限」；组织 owner/admin → 400。
   *    排除的原因不是「怕重复」，而是写一行低权限授权会制造假象：resolve 的穿透规则先命中，
   *    他的有效权限仍是 manager，但成员列表里却出现了一条 editor 行，撤掉这行看起来像降权
   * 6. kbMembers.upsert 写/覆盖一行显式授权，granted_by 记操作者
   * 值得注意的两点：
   * - 分支 A 的 userId 是请求方直接给的 UUID，ValidationPipe 只保证它是合法 UUID，
   *   所以服务层自己用 isMember 复核组织归属：外组织的人和不存在的账号都停在 404，
   *   既不会写授权行、也不会碰 user_id 外键。只有分支 B1 才会补写成员关系，
   *   因为「按邮箱把圈外人拉进来」正是那条分支的语义
   * - 分支 B1 会顺手建成员关系。全 API 写 memberships 的一共五处（auth.service 两处、
   *   invites.accept 一处、organizations.service.create 一处、这里一处），前四处写的都是「正在发起
   *   请求的那个人自己」，只有这里是替别人决定——被写的人没点任何链接、也没确认过
   *   （MembershipsRepository.create 的唯一调用方就是这一行）。这条升级要看清：本步骤让
   *   「对该库是 manager 的普通成员」当场把圈外人变成组织成员，绕开的是 InvitesService.create
   *   那道「member 一律 403」的组织级门槛，而且不给对方任何点击确认的机会；
   *   同一条路由的 B2 分支至少还要等对方接受链接才写 memberships，B1 是本次请求内就生效
   */
  async add(
    orgId: string,
    kbId: string,
    actor: CurrentMembershipValue,
    dto: AddKbMemberDto,
  ) {
    const kb = await this.kbRepo.findById(orgId, kbId);
    if (!kb) throw new NotFoundException('知识库不存在');

    // 分支 A：dto.userId 优先，两个字段同时给也走这条（userId 有值时整个邮箱分支被跳过）。
    // 这个 UUID 由请求方直接提供，必须复核组织归属：非本组织成员（含不存在的账号，它没有成员行）
    // 一律 404，既不让跨组织的授权行落库，也不会让不存在的 id 走到 user_id 外键
    let userId = dto.userId;
    if (userId) {
      if (!(await this.memberships.isMember(orgId, userId))) {
        throw new NotFoundException('该用户不在组织中');
      }
    } else if (dto.email) {
      const email = dto.email.trim().toLowerCase();
      const target = await this.users.findByEmail(email);
      if (!target) {
        // 分支 B2：查无此人 → 只发链接，不写任何授权
        const invite = await this.invites.createForKb(
          orgId,
          actor,
          kbId,
          dto.permission,
        );
        return { invited: true, invite };
      }
      // 分支 B1：账号存在，先补组织成员资格再授权
      userId = target.id;
      if (!(await this.memberships.isMember(orgId, userId))) {
        await this.memberships.create(orgId, userId, 'member');
      }
    }
    if (!userId) {
      throw new BadRequestException('请提供成员 ID 或邮箱');
    }
    // 步骤 5：两类「已经是 manager 了」的身份，写显式授权只会制造看起来能撤的假行
    if (kb.createdBy === userId) {
      throw new BadRequestException('创建者已拥有管理权限');
    }
    const targetRole = await this.kbAccessRepo.getOrgRole(orgId, userId);
    if (targetRole === 'owner' || targetRole === 'admin') {
      throw new BadRequestException('组织所有者或管理员已拥有管理权限');
    }
    // 步骤 6：upsert 而非先查再插——重复添加同一个人应当是「改权限」，不是撞唯一键报错
    await this.kbMembers.upsert({
      kbId,
      userId,
      permission: dto.permission,
      grantedBy: actor.userId,
    });
    return { added: true, userId };
  }

  /**
   * 改一条显式授权的权限等级。步骤：
   * 1. kbMembers.get 确认这条行真的存在：不在授权列表 → 404「该成员不在知识库授权列表中」。
   *    继承来的 manager 不在表里，所以改不动（见文件头）
   * 2. 走与 add 同一个 upsert：语义就是「重新授权一次」，granted_by 一并覆盖成本次的操作者
   * 三点说明：
   * - 本方法只按 kb_id 定位、不再按 org 复核归属：org 边界由控制器上的 KbPermissionGuard
   *   用 (orgId, kbId) 校验过，这里的 kbId 来自同一条路由参数（与 add/remove 不同，它们自己查了库）
   * - 不广播回收事件（remove 会）：降权后他仍在授权表里、仍有访问资格，只是能力上限变了，
   *   下一次请求的 RANK 比较自然生效；manager 被降成 editor 时，成员管理页会立刻 403
   * - 如果被改的人其实是 owner/admin 或创建者，改这行不影响他的有效权限（穿透规则先命中），
   *   界面上他应出现在 inherited 那一组
   */
  async update(
    kbId: string,
    userId: string,
    permission: 'viewer' | 'editor' | 'manager',
    grantedBy: string,
  ) {
    const existing = await this.kbMembers.get(kbId, userId);
    if (!existing) throw new NotFoundException('该成员不在知识库授权列表中');
    await this.kbMembers.upsert({
      kbId,
      userId,
      permission,
      grantedBy,
    });
    return { ok: true };
  }

  /**
   * 撤销一条显式授权。步骤：
   * 1. findById(orgId, kbId) 确认库归属（404），并留下 accessMode 给步骤 3 判断
   * 2. 只删表里存在的行：查不到 → 404（继承来的 manager 撤不掉）。
   *    DELETE 用 kb_id + user_id 双条件，不会误删这个人在别的库上的权限
   * 3. 仅当库是 restricted 才广播回收事件（reason:'kb-member-removed'）：
   *    org 模式下删掉授权行后他仍然满足判定 4（组织公开 → viewer），访问权没变，
   *    把他踢出房间只会造成无谓的前端刷新；restricted 模式下删行等于真的失去访问，
   *    所以要立刻把他移出 kb:<id> 房间并推 'kb:access-revoked'，停掉他继续收到的
   *    该库文档进度推送
   * 边界：不校验「操作者有没有资格撤这条行」——@RequireKbPermission('manager') 已放行；
   * 也不删被撤者在这个库上的 conversations 记录，他的历史问答仍在，只是此后 resolve 不再给他权限。
   */
  async remove(orgId: string, kbId: string, userId: string) {
    // 步骤 1：既为 404 兜底，也为步骤 3 取 accessMode
    const kb = await this.kbRepo.findById(orgId, kbId);
    if (!kb) throw new NotFoundException('知识库不存在');
    const existing = await this.kbMembers.get(kbId, userId);
    // 步骤 2：只撤表里有的行，继承来的 manager 走不到这里
    if (!existing) throw new NotFoundException('该成员不在知识库授权列表中');
    await this.kbMembers.delete(kbId, userId);
    // 步骤 3：org 模式下删行不改变他的访问权（仍按组织公开继承为 viewer），所以不通知；
    // restricted 模式下这次删除是真的失去访问
    if (kb.accessMode === 'restricted') {
      this.accessEvents.emit({
        userIds: [userId],
        kbId,
        reason: 'kb-member-removed',
      });
    }
    return { ok: true };
  }
}
