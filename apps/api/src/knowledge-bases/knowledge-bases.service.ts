/**
 * 知识库本体用例服务：列表、新建、详情、改设置（含 access_mode 切换）、删除。
 *
 * 与其他文件的分工：
 * - 判定规则在 kb-access.service.ts；显式授权的增删改在 kb-members.service.ts；本文件管知识库这一行本身
 * - 只有 list 需要自己算一遍有效权限（下面的 effectivePermission），因为列表一次要返回该组织里
 *   这个人能看见的全部库，逐库调 resolve 就变成「每个库最多三次查询」。
 *   代价是同一条阶梯在两个文件各写一份，改 resolve 必须同步改这里（两处差异见该函数注释）
 * - 其余方法都不再自查权限：控制器的 @RequireKbPermission 已经拦过一遍。
 *   唯一的例外是 remove，它在门槛之上又按组织角色/创建者身份额外收紧了一道（理由见该方法注释）
 * - 不写文档相关任何东西：documents / chunks / knowledge_base_members / conversations 都靠
 *   外键 ON DELETE CASCADE 在被删库时由数据库连带清理（migrations/001_init.sql）
 */
import { ForbiddenException, Injectable } from '@nestjs/common';
import { AccessEventsService } from '../common/events/access-events.service';
import { CurrentMembershipValue } from '../common/decorators/current-membership.decorator';
import { AuthUser, KbPermission, OrgRole } from '../common/types';
import {
  KnowledgeBasesRepository,
  KnowledgeBaseListItem,
} from '../database/repositories/knowledge-bases.repository';
import { StorageService } from '../storage/storage.service';
import { KbAccessService } from './kb-access.service';
import { CreateKbDto } from './dto/create-kb.dto';
import { UpdateKbDto } from './dto/update-kb.dto';

/**
 * KbAccessService.resolve 的「内存版」，用于列表页批量算有效权限，判定阶梯与它一致：
 * owner/admin 穿透 manager → 创建者 manager → 显式授权 → org 模式 viewer → null。
 *
 * 与 resolve 的两点差异（都是列表页的取数方式带来的，不是规则差异）：
 * 1. 不再查 memberships 判断成员资格：orgRole 由 OrgMemberGuard 挂上的 membership.role 传入，
 *    非成员的请求根本进不到这里；kb 归属则由 listForOrg 的 WHERE kb.org_id 限定
 * 2. 三个判定字段（createdBy/explicitPermission/accessMode）都来自列表 SQL 已经带回的列，
 *    所以整张列表只查一次库
 * 注意它不含 resolve 的「库不存在/非成员」两条前置返回，null 在这里只表示「这一行不该出现」。
 */
function effectivePermission(
  item: KnowledgeBaseListItem,
  userId: string,
  orgRole: OrgRole,
): KbPermission | null {
  if (orgRole === 'owner' || orgRole === 'admin') return 'manager';
  if (item.createdBy === userId) return 'manager';
  if (item.explicitPermission) return item.explicitPermission;
  if (item.accessMode === 'org') return 'viewer';
  return null;
}

@Injectable()
export class KnowledgeBasesService {
  constructor(
    private readonly repo: KnowledgeBasesRepository,
    private readonly kbAccess: KbAccessService,
    private readonly accessEvents: AccessEventsService,
    private readonly storage: StorageService,
  ) {}

  /**
   * 列出当前用户看得见的知识库。步骤：
   * 1. repo.listForOrg 用 SQL 里的可见性四条件先筛掉不该看见的行
   *    （owner/admin 全量 / access_mode='org' / 自己建的 / 有显式授权行），
   *    同时把两个统计数和当前用户的显式权限一起带回来
   * 2. 对每行调 effectivePermission 算出「他能干什么」，附到响应的 effectivePermission 上，
   *    前端用它渲染权限徽标（OrgHomePage）与只读/可编辑判断（DocumentsPage、KbLayout）
   * 3. filter(Boolean) 把算出 null 的行丢掉
   * 第 1 步与第 2 步是同一条规则的两份实现，所以「可见」与「有权」在正常数据下等价、
   * 这里丢掉 null 属于防御性收尾：万一两处规则被改得不一致，宁可少给也不泄露。
   * userId 与 role 都来自守卫（AuthGuard + OrgMemberGuard），不接受请求方自报。
   */
  async list(orgId: string, userId: string, role: OrgRole) {
    const items = await this.repo.listForOrg(orgId, userId, role);
    return items
      .map((item) => {
        const permission = effectivePermission(item, userId, role);
        return permission
          ? {
              id: item.id,
              name: item.name,
              description: item.description,
              accessMode: item.accessMode,
              createdBy: item.createdBy,
              createdAt: item.createdAt,
              updatedAt: item.updatedAt,
              effectivePermission: permission,
              documentCount: item.documentCount,
              memberCount: item.memberCount,
            }
          : null;
      })
      .filter(Boolean);
  }

  /**
   * 新建知识库。步骤：
   * 1. name/description 先 trim；accessMode 缺省 'org'（新库默认对整个组织可见）
   * 2. repo.create 一条 INSERT，created_by 记当前用户——这一列同时是权限阶梯判定 2 的依据，
   *    所以建库不需要另外写一行 knowledge_base_members 授权，创建者的 manager 是推导出来的
   * 3. 回包时补 effectivePermission:'manager' 与两个 0：created_by 刚写成自己，判定 2 必然命中；
   *    新库不可能已经有文档或授权行，于是省掉一次回查
   * 边界：任何本组织成员都能建库（POST 路由只挂 OrgMemberGuard，没有 KbPermissionGuard），
   *      默认 org 模式下这个库立刻对全组织可见
   */
  async create(orgId: string, userId: string, dto: CreateKbDto) {
    const kb = await this.repo.create({
      orgId,
      name: dto.name.trim(),
      description: (dto.description ?? '').trim(),
      accessMode: dto.accessMode ?? 'org',
      createdBy: userId,
    });
    return {
      ...kb,
      effectivePermission: 'manager' as const,
      documentCount: 0,
      memberCount: 0,
    };
  }

  /**
   * 知识库详情。权限判定不在这里：控制器是 @UseGuards(KbPermissionGuard) +
   * @RequireKbPermission('viewer')，守卫解析出的等级经 @CurrentKbPermission 传进来，
   * 本方法只按 (orgId, kbId) 取本体字段并把它原样回给前端。
   * getKbOrThrow 在这里的作用是「守卫取数与这里取数之间库被人删掉了」的兜底（404）。
   */
  async get(orgId: string, kbId: string, permission: KbPermission) {
    const kb = await this.kbAccess.getKbOrThrow(orgId, kbId);
    return { ...kb, effectivePermission: permission };
  }

  /**
   * 改知识库设置：name / description / access_mode 三个字段都可单独给。步骤：
   * 1. getKbOrThrow 读当前行：未传的字段要沿用旧值，因为仓储层的 UPDATE 是全字段覆盖
   *    （PATCH 语义靠「先读后写」实现，不是靠 SQL 拼部分 SET）
   * 2. 只有一种转换需要算受影响的人：current='org' 且 next='restricted'。
   *    调 affectedByRestriction 取「纯靠组织公开模式才看得见这个库」的普通成员，
   *    它排除三类人：owner/admin（穿透成 manager，不受模式影响）、创建者（天生 manager）、
   *    已有显式授权行的人（他们的权限写在表里，与模式无关）。
   *    别把这三类当成穷尽清单——那是三条 WHERE 的写法，不等于可达行为：
   *    m.user_id <> (SELECT created_by ...) 在子查询返回 NULL 时整个谓词是 NULL（永不为真），
   *    而 created_by 可空（migrations/001_init.sql:62，REFERENCES users ON DELETE SET NULL，
   *    创建者被删掉就是这种数据），此时一行都查不出来、受影响列表恒为空，
   *    于是第 4 步的 if (affected.length) 不成立、谁都收不到回收事件（房间不会当场清）。
   *    这段代码本阶段刻意不改，访问权仍由此后每次 resolve 兜住；读到「排除三类人」时要记得
   *    还有第四种情况：整条谓词失效、一个人都不通知
   * 3. repo.update 落库
   * 4. 落库成功且受影响列表非空时，广播权限回收事件（reason:'kb-restricted'）
   *
   * 第 4 步为什么要广播：这个库刚才对全组织开放，前端可能已经把它列进侧栏、实时连接也可能
   * 已经 join 了 kb:<id> 房间；切成 restricted 后这些人继续留在房间里就会一直收到该库的
   * document:status 推送（文档 id、状态、切片数这类元信息）。emit 让网关当场把他们踢出房间
   * 并推 'kb:access-revoked'，界面立刻收走这个库，而不是等用户自己刷新。
   * 但广播不是执法：事件走的是进程内内存总线，丢了不补、跨实例不广播；真正的拒绝来自此后
   * 每次请求重新 resolve（HTTP 走 KbPermissionGuard，WS 的 kb:join / chat:send 走
   * KbAccessService.require），按第 2 步的规则他们都会算成 null，自然拿不到内容。
   * 顺序也刻意是「先改库、再通知」：反过来会出现「前端已把他踢出房间、库里其实还是 org 模式」。
   *
   * 反方向（restricted → org）不需要任何通知：那是放宽访问，多出来的人自己刷新就能看到。
   * 返回值里的 effectivePermission 写死 'manager' 不是偷懒：这个路由的门槛是
   * @RequireKbPermission('manager')，能走到这里的请求者有效权限必然是 manager。
   */
  async update(
    orgId: string,
    kbId: string,
    membership: CurrentMembershipValue,
    dto: UpdateKbDto,
  ) {
    const current = await this.kbAccess.getKbOrThrow(orgId, kbId);
    const nextAccessMode = dto.accessMode ?? current.accessMode;
    const nextName = dto.name?.trim() ?? current.name;
    const nextDescription =
      dto.description !== undefined ? dto.description.trim() : current.description;

    // 步骤 2：只有 org→restricted 这一种切换会真的把人挡在门外，另三种组合不用算受影响人群
    let affected: string[] = [];
    if (current.accessMode === 'org' && nextAccessMode === 'restricted') {
      affected = await this.repo.affectedByRestriction(orgId, kbId);
    }

    // 步骤 3：整行覆盖式 UPDATE（三个值都已在上一步合并好，未传字段保持原值）
    const updated = await this.repo.update(orgId, kbId, {
      name: nextName,
      description: nextDescription,
      accessMode: nextAccessMode,
    });

    // 步骤 4：改库成功之后才通知，且列表为空就完全不发事件
    if (affected.length) {
      this.accessEvents.emit({
        userIds: affected,
        kbId,
        reason: 'kb-restricted',
      });
    }

    return {
      ...updated,
      effectivePermission: 'manager' as const,
    };
  }

  /**
   * 删除知识库。步骤：
   * 1. getKbOrThrow 确认库在本组织下
   * 2. 再收紧一道资格：只有 owner、admin 或库的创建者可删。控制器的
   *    @RequireKbPermission('manager') 只保证「有效权限是 manager」，
   *    而被单独授权成 manager 的普通成员也满足它——删库不可逆，所以本模块唯一
   *    在守卫门槛之上再收紧一道资格的地方就在这里，把「被授权的 manager」排除掉
   *    （list 里的 effectivePermission 也是服务层算权限，但那是守卫没覆盖的批量场景，不是「再收紧」）
   * 3. repo.delete 只删 knowledge_bases 一行：documents/chunks/knowledge_base_members/
   *    conversations（messages 再往下一级）都由 FK ON DELETE CASCADE 连带清理，
   *    连带的还有绑定的邀请行——invites.kb_id 也是 ON DELETE CASCADE
   * 4. storage.removeKbDir 递归删该库的上传目录（rm 带 force:true，目录本来不存在也不报错）
   * 两点如实说明：
   * - 第 3、4 步不在同一个事务里：数据库行删成功而目录删除失败会留下孤儿文件目录
   *   （反过来「文件没了、行还在」才是数据完整性问题，所以顺序是这样）
   * - 删库不 emit 权限回收事件（与 update 不同）：库已经不在 listForOrg 的结果里，
   *   前端刷新就消失；残留影响只是他仍在 kb:<id> 房间里，而那个房间此后不会再有任何事件
   */
  async remove(
    orgId: string,
    kbId: string,
    user: AuthUser,
    membership: CurrentMembershipValue,
  ) {
    const kb = await this.kbAccess.getKbOrThrow(orgId, kbId);
    // 步骤 2：三个身份之一即可，注意这里看的是组织角色 + 创建者，不看知识库级授权行
    const isManager =
      membership.role === 'owner' ||
      membership.role === 'admin' ||
      kb.createdBy === user.id;
    if (!isManager) throw new ForbiddenException('只有创建者或组织管理员可以删除知识库');

    await this.repo.delete(orgId, kbId);
    // 步骤 4：文件与数据库行分两步删除，失败不回滚数据库
    await this.storage.removeKbDir(orgId, kbId);
    return { ok: true };
  }
}
