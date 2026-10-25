/**
 * 认证用例服务：注册、登录、查自己、登出、改密码。
 * 写到的表共六张：users、sessions、invites、organizations、memberships、knowledge_base_members
 * （不是只动「用户+会话」——注册一次就要落组织/成员关系，知识库级邀请还带一条 KB 授权）。
 *
 * 整体职责与边界：
 * - 只管「身份与成员资格」的写入；签发会话、写 Cookie 是控制器的编排，本服务不碰 HTTP
 * - register 是本服务唯一走 withTransaction 的多表写入点：用户、组织/成员关系、邀请回执
 *   要么全成要么全无。changePassword 同样跨 users+sessions 两张表写入，但没有包事务，
 *   中途失败会留下「新哈希已写、其他设备未踢」的窗口
 * - 登录失败（邮箱不存在 / 密码错）永远回同一句「邮箱或密码错误」，不给枚举账号留线索
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AppConfigService } from '../config/config.service';
import { hashToken } from '../config/env.util';
import { DatabaseService } from '../database/database.service';
import { OrganizationsRepository } from '../database/repositories/organizations.repository';
import {
  UserRow,
  UsersRepository,
} from '../database/repositories/users.repository';
import { AuthUser, OrgRole, OrgSummary } from '../common/types';
import { PasswordService } from './password.service';
import { SessionService } from './session.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { ChangePasswordDto } from './dto/change-password.dto';

/** 注册/登录/GET me 的统一返回体：身份 + 该用户可见的组织列表（前端据此选组织） */
export interface AuthResponse {
  user: AuthUser;
  organizations: OrgSummary[];
}

@Injectable()
export class AuthService {
  constructor(
    private readonly db: DatabaseService,
    private readonly users: UsersRepository,
    private readonly organizations: OrganizationsRepository,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * 注册：两种入口共用一条流程——带邀请链接进别人组织，不带就开新组织当 owner。
   * 步骤：
   * 1. 邮箱 trim+小写归一（库里判重、登录查找都按小写走，这里先统一口径）；
   *    事务外先算好 bcrypt 哈希并预生成 userId——哈希计算慢，别拿着事务和行锁算
   * 2. 开事务：
   *    2.1 查重：lower(email) 命中已有用户 → 409「该邮箱已注册」
   *    2.2 插入 users（只落 id/email/password_hash/name）
   *    2.3a 带 inviteToken：对 token 算 SHA-256 摘要，FOR UPDATE 锁住 invites 行——
   *         同一链接并发注册时后到者等锁（库未显式设隔离级别，即 Postgres 默认 READ COMMITTED），
   *         锁回来读到的是先提交者更新后的行，accepted_at 检查必然命中，链接不会被双花；
   *         链接无效 → 400、已被用 → 409、已过期 → 410；
   *         建 memberships（角色沿用邀请里预定的 admin/member）；邀请若绑定了知识库，
   *         再 upsert 一条 knowledge_base_members 授权（ON CONFLICT 覆盖旧权限）；
   *         回写 invites.accepted_at/accepted_by，链接就此作废
   *    2.3b 不带邀请：先查 REGISTRATION_ENABLED（默认开放，显式配 'false' 才关）→ 关闭时 403；
   *         orgName 必填否则 400；建 organizations + 以 owner 身份建 memberships
   * 3. 事务收尾前的并发兜底：两个请求同时通过 2.1 的查重时，后插入者会撞 email 唯一约束
   *    （Postgres 错误码 23505），在 catch 里同样转成 409，查重只是快路径、约束才是底线
   * 4. 事务提交成功后重查：findById 拿安全投影 + listForUser 拿组织列表返回
   * 注意：本方法不建会话、不写 Cookie——控制器拿到返回后另调 SessionService.createSession
   */
  async register(dto: RegisterDto): Promise<AuthResponse> {
    // 步骤 1：归一化与事务外的慢计算
    const email = dto.email.trim().toLowerCase();
    const passwordHash = await this.passwords.hash(dto.password);
    const userId = randomUUID();

    try {
      await this.db.withTransaction(async (client) => {
        // 步骤 2.1：查重（大小写不敏感，口径与建用户时的归一化一致）
        const existing = await client.query(
          'SELECT 1 FROM users WHERE lower(email) = lower($1)',
          [email],
        );
        if (existing.rowCount) {
          throw new ConflictException('该邮箱已注册');
        }

        // 步骤 2.2：落用户；RETURNING 只取对外安全的三字段
        const userResult = await client.query<AuthUser>(
          `INSERT INTO users (id, email, password_hash, name)
           VALUES ($1, $2, $3, $4)
           RETURNING id, email, name`,
          [userId, email, passwordHash, dto.name.trim()],
        );
        const user = userResult.rows[0];

        let orgId: string;
        let role: OrgRole;

        if (dto.inviteToken) {
          // 步骤 2.3a：FOR UPDATE 行锁让「校验链接 + 消费链接」原子化，防一张邀请注册两个人
          const inviteResult = await client.query<{
            id: string;
            org_id: string;
            role: 'admin' | 'member';
            expires_at: Date;
            accepted_at: Date | null;
            kb_id: string | null;
            kb_permission: 'viewer' | 'editor' | 'manager' | null;
          }>(
            `SELECT id, org_id, role, expires_at, accepted_at, kb_id, kb_permission
             FROM invites WHERE token_hash = $1 FOR UPDATE`,
            [hashToken(dto.inviteToken)],
          );
          const invite = inviteResult.rows[0];
          if (!invite) throw new BadRequestException('邀请链接无效');
          if (invite.accepted_at) throw new ConflictException('邀请链接已被使用');
          if (new Date(invite.expires_at).getTime() <= Date.now()) {
            throw new GoneException('邀请链接已过期');
          }

          // 进的是邀请人预定的组织与角色，注册者自己无权选择
          await client.query(
            `INSERT INTO memberships (id, org_id, user_id, role)
             VALUES ($1, $2, $3, $4)`,
            [randomUUID(), invite.org_id, user.id, invite.role],
          );
          // 知识库级邀请才带这两列：upsert 而非纯插入，重复授权时新权限覆盖旧权限
          if (invite.kb_id && invite.kb_permission) {
            await client.query(
              `INSERT INTO knowledge_base_members (kb_id, user_id, permission, granted_by)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (kb_id, user_id)
               DO UPDATE SET permission = EXCLUDED.permission`,
              [invite.kb_id, user.id, invite.kb_permission, user.id],
            );
          }
          // 链接标记为已消费：此后同一 token 再来，上面的 accepted_at 检查会 409
          await client.query(
            `UPDATE invites SET accepted_at = now(), accepted_by = $1 WHERE id = $2`,
            [user.id, invite.id],
          );
          orgId = invite.org_id;
          role = invite.role;
        } else {
          // 步骤 2.3b：开放注册自助建组织；开关默认开，只认显式 'false'
          if (!this.config.registrationEnabled) {
            throw new ForbiddenException('当前未开放注册，请使用邀请链接');
          }
          if (!dto.orgName?.trim()) {
            throw new BadRequestException('请填写组织名称');
          }
          orgId = randomUUID();
          role = 'owner';
          await client.query(
            `INSERT INTO organizations (id, name, created_by)
             VALUES ($1, $2, $3)`,
            [orgId, dto.orgName.trim(), user.id],
          );
          await client.query(
            `INSERT INTO memberships (id, org_id, user_id, role)
             VALUES ($1, $2, $3, $4)`,
            [randomUUID(), orgId, user.id, role],
          );
        }
      });
    } catch (error) {
      // 步骤 3：并发下两个请求都过了查重时，lower(email) 上的函数式唯一索引
      // （001_init.sql 的 users_email_lower_idx）会让后插入者报 23505，
      // 转成和查重一样的 409，对外表现完全一致
      if ((error as { code?: string }).code === '23505') {
        throw new ConflictException('该邮箱已注册');
      }
      throw error;
    }

    // 步骤 4：事务已提交，用仓储重查安全投影（此时读到的必然是完整的新用户）
    const user = await this.users.findById(userId);
    if (!user) throw new Error('registration failed');
    const organizations = await this.organizations.listForUser(userId);
    return { user, organizations };
  }

  /**
   * 登录：只验密码，不建会话（会话由控制器验成功后调 SessionService 另发）。
   * 步骤：
   * 1. lower(email) 大小写不敏感查找；查不到 → 401
   * 2. bcrypt 比对口令；不符 → 401——两处用同一句「邮箱或密码错误」，
   *    让攻击者无法通过报错差异枚举系统里有哪些邮箱
   * 3. 返回用户 + 组织列表，与 register/me 同一个 AuthResponse 形状
   */
  async login(dto: LoginDto): Promise<AuthResponse> {
    const row = await this.users.findByEmail(dto.email);
    if (!row) throw new UnauthorizedException('邮箱或密码错误');
    const matches = await this.passwords.verify(dto.password, row.password_hash);
    if (!matches) throw new UnauthorizedException('邮箱或密码错误');

    const organizations = await this.organizations.listForUser(row.id);
    return {
      user: { id: row.id, email: row.email, name: row.name },
      organizations,
    };
  }

  /** 查「我是谁」：AuthGuard 已给出可信 user，这里只补一份最新的组织列表 */
  async me(user: AuthUser): Promise<AuthResponse> {
    const organizations = await this.organizations.listForUser(user.id);
    return { user, organizations };
  }

  /** 登出：仅吊销当前会话，同用户其他设备不动 */
  async logout(sessionId: string): Promise<void> {
    await this.sessions.revoke(sessionId);
  }

  /**
   * 改密码：验证旧密码 → 换新哈希 → 踢掉其他所有设备。
   * 步骤：
   * 1. findByIdWithPassword 取回带哈希的行（普通 findById 刻意不返回 password_hash）
   * 2. bcrypt 比对当前密码，不对 → 400「当前密码不正确」（与登录不同，这里已是登录态，
   *    不存在枚举风险，可以给明确文案）
   * 3. 写入新哈希；updatePasswordHash 只存调用方算好的哈希，加密口径统一在 PasswordService
   * 4. revokeOthers 删除该用户除当前 sessionId 外的所有会话——旧设备上残留的 Cookie
   *    会立刻在 AuthGuard 处变 401，而操作者自己这一端不掉线
   * 注意：步骤 3 与步骤 4 是两条独立 SQL，本方法没有 withTransaction 包裹，不在同一个事务里；
   *       若第 3 步已提交而第 4 步失败，其他设备的旧会话行仍然有效（新哈希已生效，旧口令再也登不上，
   *       但已签发的令牌还没被踢）。
   */
  async changePassword(
    userId: string,
    sessionId: string,
    dto: ChangePasswordDto,
  ): Promise<void> {
    const row = await this.users.findByIdWithPassword(userId);
    if (!row) throw new UnauthorizedException('用户不存在');
    const matches = await this.passwords.verify(
      dto.currentPassword,
      row.password_hash,
    );
    if (!matches) throw new BadRequestException('当前密码不正确');

    const newHash = await this.passwords.hash(dto.newPassword);
    await this.users.updatePasswordHash(userId, newHash);
    await this.sessions.revokeOthers(userId, sessionId);
  }
}
