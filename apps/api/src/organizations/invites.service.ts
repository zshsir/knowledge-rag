/**
 * 邀请用例服务：签发邀请、查列表、撤销，以及把令牌换成成员资格。
 *
 * 一次性令牌语义（三条都能在代码里逐条对上）：
 * - 库里只存 token_hash（SHA-256 摘要，见 config/env.util.ts），该列带 UNIQUE 约束
 *   （migrations/001_init.sql:46）；原始令牌只在 issueInvite 的返回值与 url 里出现一次，
 *   之后任何接口都连这串摘要也拿不到：管理页用的 list 压根不 SELECT token_hash 这一列
 *   （invites.repository.ts:86），findByHash 回的 InviteRecord 同样没有摘要字段，
 *   摘要只在 SQL 的 WHERE 里当作等值匹配的钥匙；对外可见的只剩 accepted_at / expires_at 这类状态列。
 *   因此「签发之后」原文与摘要都不再出现在任何响应里（摘要自始至终不出现），
 *   链接既无法从数据库中被复原出来，也无法从接口返回里被抄走
 * - accepted_at 非空即作废：accept 在事务最后一步把它写成 now()，同一个令牌再来就是
 *   409「邀请已被使用」——「一条链接恰好能用一次」是靠这个字段实现的
 * - expires_at 在签发时按「当下 + INVITE_TTL_DAYS(7 天)」算死，之后没有任何续期路径；
 *   过期判 410（Gone）而不是 403——410 的语义是「这个资源曾经存在、现在没了」，
 *   与「你没权限」是两回事；三种失败对外都只有「状态码 + 一句 message」，
 *   前端 JoinPage 直接把 ApiError.message 显示出来（apps/web/src/features/auth/JoinPage.tsx:63）
 *
 * 职责与边界：
 * - 令牌生成、摘要计算、有效期推算、可用性判断都在本文件；InvitesRepository 只写 SQL
 * - 组织级邀请只写 memberships；带 kb_id 的邀请额外写一条 knowledge_base_members 授权
 * - 撤销靠的是删行（revoke），删掉之后 accept 按摘要查不到就是 404；
 *   但签发人后来被移出组织不会让他已发出的链接失效——accept 不复核 created_by 现在的身份
 * - 与 auth.service.register 的邀请分支是同一张 invites 表的两条消费路径：那条给「带着链接注册新用户」，
 *   本文件的 accept 给「已登录用户点链接补加入」。两边都用 SELECT ... FOR UPDATE 锁行 +
 *   「不存在/已使用/已过期」三态 + 同样的 memberships 与 knowledge_base_members 写入，
 *   但对外表现并不完全一致：查不到链接时 register 是 400「邀请链接无效」，这里是 404「邀请不存在」；
 *   409 与 410 的状态码两边相同。改这套语义时要一起看两处
 * - 不建会话、不写 Cookie，也不返回令牌之外的组织信息
 */
import {
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { CurrentMembershipValue } from '../common/decorators/current-membership.decorator';
import { OrgRole, OrgSummary } from '../common/types';
import { AppConfigService } from '../config/config.service';
import { hashToken } from '../config/env.util';
import { DatabaseService } from '../database/database.service';
import {
  InviteRecord,
  InvitesRepository,
  InviteView,
} from '../database/repositories/invites.repository';

/** 邀请有效期（天）。只在 issueInvite 里算一次，之后不续期，也不允许调用方覆盖 */
const INVITE_TTL_DAYS = 7;

/**
 * 组织邀请与知识库级邀请共用一套签发实现，差别只在门槛与 role/kb 参数。
 * 角色语义：邀请的 role 只能是 admin 或 member（invites.role 上的 CHECK 约束），
 * owner 永远不可能通过邀请产生。
 */
@Injectable()
export class InvitesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly invites: InvitesRepository,
    private readonly config: AppConfigService,
  ) {}

  /**
   * 组织级邀请：签一条「按了就是本组织 admin/member」的链接。步骤：
   * 1. member 一律 403——普通成员不能拉人进来
   * 2. admin 只能邀请普通成员（role==='admin' 时 403）：管理员没有制造管理员的能力，
   *    想拉一个 admin 进组织必须由 owner 签发
   * 3. 交 issueInvite 落库并回链接
   * 与 createForKb 的权限差异：本方法的门槛是「组织角色」（来自 OrgMemberGuard 挂上的
   * membership.role，由控制器把 actor 传进来），签出的链接不带知识库，作用范围是整个组织。
   */
  async create(
    orgId: string,
    actor: CurrentMembershipValue,
    role: 'admin' | 'member',
  ) {
    if (actor.role === 'member') {
      throw new ForbiddenException('没有创建邀请的权限');
    }
    if (actor.role === 'admin' && role === 'admin') {
      // 提权到 admin 是 owner 专属动作，否则管理员可以互相拉帮结派地扩编
      throw new ForbiddenException('管理员只能邀请普通成员');
    }
    return this.issueInvite({ orgId, actor, role });
  }

  /**
   * 知识库级邀请：给「还不是组织成员、但要把他加进某一条知识库」的人生成链接。
   * 与普通 create 的两点差异（都在代码里，不在注释里）：
   * 1. role 固定 'member'：接受者进组织后只是普通成员，多出来的权限只有绑定的那一条库
   *    （createForKb 里连 role 参数都不收，杜绝「借知识库邀请把人提成组织 admin」）
   * 2. 本方法体内没有任何角色判断，授权完全来自调用它的那条路由：唯一调用方是
   *    KbMembersService.add 里的「邮箱查无此人」分支，挂在
   *    POST orgs/:orgId/knowledge-bases/:kbId/members 上，那里是
   *    @UseGuards(KbPermissionGuard) + @RequireKbPermission('manager')。
   *    也就是说「能签这条链接」= 「对该知识库是 manager」，而不是「是组织 owner/admin」——
   *    被单独授权成 manager 的普通成员同样能签，与本方法体内不写角色判断正好相配：
   *    两层门槛（组织角色 / 知识库权限）管的是不同的东西，这里不该重复 create 的那道。
   *    把上面两点连起来读，结论是：本方法是 create 那道「member 一律 403」之外的第二条入组织通道——
   *    一个只在组织里是普通成员、仅对某一条库是 manager 的人，凭它就能把圈外人拉成组织 member。
   *    作用范围确实窄（角色写死 member、多出来的权限只有绑定的那一条库），但门槛来源与 create 无关，
   *    这是现状而非本方法刻意放宽的设计，改这里的权限模型时要把这条通道一起算进去。
   * 落库时 kb_id/kb_permission 一并写入，accept 据此在同一事务里补上授权行。
   */
  async createForKb(
    orgId: string,
    actor: CurrentMembershipValue,
    kbId: string,
    permission: 'viewer' | 'editor' | 'manager',
  ) {
    return this.issueInvite({
      orgId,
      actor,
      role: 'member',
      kbId,
      kbPermission: permission,
    });
  }

  /**
   * 两种邀请共用的签发实现（本文件唯一的写 invites 入口，private 所以外部调不到）。步骤：
   * 1. 现场生成 32 字节随机令牌并转 base64url（约 43 字符）。熵足够高，所以摘要可以不加盐
   * 2. expires_at = 此刻 + INVITE_TTL_DAYS 天，用应用进程的 Date.now() 算；
   *    publicInfo 与 accept 判过期时用的也是各自进程里的 Date.now()，所以整套有效期只认应用时钟，
   *    数据库的 now() 只在 accepted_at 那一刻出现
   * 3. 落库存的是 hashToken(token) 摘要 + 组织/角色/有效期/签发人，可选的 kbId/kbPermission
   *    为空即组织级邀请；created_by 只为列表页展示「谁发的」，accept 时不复核他的身份
   * 4. 响应回原始 token 与拼好的 url：原始令牌就此离开服务端一次，之后无从再取
   * url 的基址是 APP_ORIGIN（getOrThrow，没配就直接抛错），所以签发链接不可能拼出错误的跳转域；
   * /join/<token> 是前端的接受页路由（apps/web 侧），令牌放在路径里而不是 query 里
   */
  private async issueInvite(input: {
    orgId: string;
    actor: CurrentMembershipValue;
    role: 'admin' | 'member';
    kbId?: string;
    kbPermission?: 'viewer' | 'editor' | 'manager';
  }) {
    // 步骤 1：高熵随机令牌，摘要算法因此可以不加盐（见 config/env.util.ts）
    const token = randomBytes(32).toString('base64url');
    // 步骤 2：签发即定死过期时刻，没有续期入口
    const expiresAt = new Date(
      Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000,
    );
    const id = await this.invites.create({
      orgId: input.orgId,
      tokenHash: hashToken(token),
      role: input.role,
      createdBy: input.actor.userId,
      expiresAt,
      kbId: input.kbId,
      kbPermission: input.kbPermission,
    });

    return {
      id,
      token,
      role: input.role,
      expiresAt,
      url: `${this.config.appOrigin}/join/${token}`,
    };
  }

  /**
   * 邀请列表：member 403，owner/admin 可看。
   * 仓储层的 SELECT 刻意不含 token_hash（见 invites.repository.list），所以管理页看不到可用令牌；
   * 也不含 kb_id/kb_permission：知识库级邀请在这里与组织级邀请长得一模一样，
   * 都是 role='member' 的一行，无法从列表区分「这条链接只会给一条库的权限」。
   * 已使用（acceptedAt 非空）与已过期的链接依然列在这里——这是审计痕迹，不是可点击的入口。
   */
  async list(orgId: string, actor: CurrentMembershipValue): Promise<InviteView[]> {
    if (actor.role === 'member') {
      throw new ForbiddenException('没有查看邀请的权限');
    }
    return this.invites.list(orgId);
  }

  /**
   * 撤销邀请：member 403，其余一律删行。
   * 步骤：
   * 1. 资格与 create 同源：看的是 OrgMemberGuard 挂上的组织角色，与这条邀请是不是自己签的无关
   *    （admin 可以撤掉 owner 签发的邀请，撤销不算提权）
   * 2. invites.delete 的 WHERE 同时要求 id 与 org_id：org_id 是硬边界，
   *    A 组织的管理员凭 inviteId 删不掉 B 组织的邀请；删不存在的 id 也不报错（DELETE 幂等）
   * 3. 删行即作废：此后 accept 按摘要查不到行，回 404「邀请不存在」
   * 注意对「已被接受过」的链接执行撤销只是抹掉签发记录，不会撤回对方的成员资格——
   * 那要用 MembersService.remove；撤销也不通知任何在线连接，因为被撤的链接本来就没有访问权。
   */
  async revoke(
    orgId: string,
    actor: CurrentMembershipValue,
    inviteId: string,
  ): Promise<{ ok: true }> {
    if (actor.role === 'member') {
      throw new ForbiddenException('没有撤销邀请的权限');
    }
    await this.invites.delete(orgId, inviteId);
    return { ok: true };
  }

  /**
   * 确认页用的公开详情：由 @Public 的 GET /invites/:token 调用，未登录也能读。
   * 步骤：
   * 1. 用原始令牌现算摘要去等值查库（库里只有摘要，这一步等价于验票）
   * 2. 查不到 → 404；不回任何可推断组织内部结构的字段
   * 3. 返回 orgName/role/valid/expiresAt 四项，其中 valid 是算出来的：未被接受且 expires_at 仍在将来
   * 刻意不在这里抛错：确认页要先展示「你将加入 XXX 组织，角色是 member/admin」，
   * 再用 valid=false 就地告知链接已失效，而不是把一个还在渲染的表单换成错误页。
   * 也不回 kb_id/kb_permission：确认页无需展示知识库信息（accept 时会从行里读，不依赖响应）。
   */
  async publicInfo(token: string) {
    const invite = await this.invites.findByHash(hashToken(token));
    if (!invite) throw new NotFoundException('邀请不存在');
    // valid 同时看「没用过」和「没过期」，任一不成立都只是把 valid 置 false，不改状态码
    const valid =
      !invite.acceptedAt && new Date(invite.expiresAt).getTime() > Date.now();
    return {
      orgName: invite.orgName,
      role: invite.role,
      valid,
      expiresAt: invite.expiresAt,
    };
  }

  /**
   * 已登录用户凭令牌接受邀请：把令牌换成 memberships 行（必要时再加一条知识库授权）。
   * 全在一个事务里，步骤顺序不能换：
   * 1. SELECT ... WHERE token_hash=$1 FOR UPDATE：按摘要命中并锁住邀请行。
   *    两个人同时点同一条链接时，后到者必须等前者提交，醒来读到的是已写入 accepted_at 的行，
   *    第 2 步必然判成 409；没有这把锁，两条请求都会看到「未使用」，一条链接就发出了两次资格。
   *    （withTransaction 是裸 BEGIN，Postgres 默认 READ COMMITTED，这个前提决定了锁是否够用）
   * 2. 三态校验，顺序即代码顺序：查不到行 → 404（已被撤销的链接也落在这里）；
   *    accepted_at 非空 → 409 已使用；expires_at <= 此刻 → 410 已过期。
   *    「已使用」排在「已过期」之前，所以两者同时成立时对外报 409
   * 3. 查重 memberships：他可能早被另一条链接拉进过这个组织 → 409「你已经加入该组织」，
   *    避免同一组织出现两行成员关系（也避免把已有人的角色按新邀请改写）
   * 4. INSERT memberships：角色直接沿用邀请里预定的 admin/member，绝不接受请求方传角色
   * 5. 邀请带 kb_id + kb_permission 时 upsert 一条 knowledge_base_members 授权：
   *    ON CONFLICT 覆盖旧权限，所以「对同一条库再发一条低权限链接并接受」等于改权限而不是报错；
   *    granted_by 写的是接受者自己的 id（不是签发人），语义是「这条授权由本次接受带来」
   * 6. UPDATE invites SET accepted_at=now(), accepted_by=userId：一次性语义在此落地，链接就此作废
   * 7. 事务提交后只回 {id, name, role}：不建会话、不改 Cookie、不返回该组织的其他信息
   * 说明：第 4~6 步用行内 SQL 而不是 Repository 方法，是因为它们必须共用同一个 client 才落在
   * 同一个事务里；InvitesRepository.markAccepted 是第 6 步那份 SQL 的副本，当前无调用方。
   * 被移出组织后，同一条链接不会重新可用——第 2 步就撞 409，要再加人得重新签发。
   */
  async accept(
    userId: string,
    token: string,
  ): Promise<{ organization: OrgSummary }> {
    const invite = await this.db.withTransaction(async (client) => {
      // 步骤 1：FOR UPDATE 锁住这一行，防的就是「一条链接双花」
      const result = await client.query<{
        id: string;
        org_id: string;
        org_name: string;
        role: 'admin' | 'member';
        expires_at: Date;
        accepted_at: Date | null;
        kb_id: string | null;
        kb_permission: 'viewer' | 'editor' | 'manager' | null;
      }>(
        `SELECT i.id, i.org_id, o.name AS org_name, i.role, i.expires_at, i.accepted_at,
                i.kb_id, i.kb_permission
         FROM invites i JOIN organizations o ON o.id = i.org_id
         WHERE i.token_hash = $1 FOR UPDATE`,
        [hashToken(token)],
      );
      const row = result.rows[0];
      // 步骤 2：三态校验（404 不存在/已撤销 → 409 已使用 → 410 已过期），全部先于任何写入
      if (!row) throw new NotFoundException('邀请不存在');
      if (row.accepted_at) throw new ConflictException('邀请已被使用');
      if (new Date(row.expires_at).getTime() <= Date.now()) {
        throw new GoneException('邀请已过期');
      }

      // 步骤 3：查重成员关系。这里的 org_id 取自邀请行而不是请求参数，请求方无法指定要加入哪个组织
      const existing = await client.query(
        'SELECT 1 FROM memberships WHERE org_id = $1 AND user_id = $2',
        [row.org_id, userId],
      );
      if (existing.rowCount) {
        throw new ConflictException('你已经加入该组织');
      }

      // 步骤 4：建成员关系，角色照抄邀请里预定的 admin/member
      await client.query(
        `INSERT INTO memberships (id, org_id, user_id, role)
         VALUES ($1, $2, $3, $4)`,
        [randomUUID(), row.org_id, userId, row.role],
      );
      // 步骤 5：知识库作用域的邀请额外授一条库权限（两个字段都得非空，只填一个的脏数据按组织级邀请处理）
      if (row.kb_id && row.kb_permission) {
        await client.query(
          `INSERT INTO knowledge_base_members (kb_id, user_id, permission, granted_by)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (kb_id, user_id)
           DO UPDATE SET permission = EXCLUDED.permission`,
          [row.kb_id, userId, row.kb_permission, userId],
        );
      }
      // 步骤 6：标记已用，链接作废（accepted_by 记下是谁消费的，供邀请列表页展示）
      await client.query(
        'UPDATE invites SET accepted_at = now(), accepted_by = $1 WHERE id = $2',
        [userId, row.id],
      );
      return {
        orgId: row.org_id,
        orgName: row.org_name,
        role: row.role as OrgRole,
      };
    });

    // 步骤 7：事务已提交，只回最小的组织信息；前端拿到后自行刷新组织列表（不建会话、不动 Cookie）
    return {
      organization: {
        id: invite.orgId,
        name: invite.orgName,
        role: invite.role,
      },
    };
  }
}
