/**
 * 知识库权限解析服务：整个权限模型的心脏，只判定、不读写业务数据。
 *
 * 三个入口的分工：
 * - resolve：算「有效权限」，返回 KbPermission 或 null，不抛错——给守卫和需要自己决定
 *   错误语义的调用方用（除本文件内的 require 之外，外部唯一调用方是 KbPermissionGuard）
 * - require：resolve + 门槛比较，把 null 变成 404、把等级不足变成 403——给服务层用，
 *   文档、问答、实时网关这些不在 HTTP 守卫链上的调用方全靠它
 * - getKbOrThrow：只确认「这个库确实属于这个组织」并取回本体字段，完全不判权限
 *
 * 职责与边界：
 * - 判定所需的三次取数全在 KbAccessRepository（getKb / getOrgRole / getMemberPermission），
 *   本文件只负责「三者怎么合成一个权限等级」，SQL 与租户条件的写法不在这里
 * - 每次判定都重新查库、不缓存：这正是「改了权限立刻生效」的机制，也是移除成员时
 *   不删会话行也安全的底气（组织/知识库作用域的请求都会重新走一遍这里）
 * - 等级比较用的 RANK 表在 common/guards/kb-permission.guard.ts 里还有一份同内容副本，
 *   调整等级顺序或新增等级必须两处同改
 * - 与 knowledge-bases.service.ts 里的 effectivePermission 是同一条阶梯的两种写法：
 *   这里逐库现查，列表页那份直接用 SQL 已经带回的字段在内存里算，理由见那边的注释
 */
import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { KbPermission } from '../common/types';
import { KbAccessRepository, KbRow } from '../database/repositories/kb-access.repository';

/** 权限等级排序表：viewer=1 < editor=2 < manager=3；「高等级包含低等级」这件事只由这张表表达 */
const RANK: Record<KbPermission, number> = {
  viewer: 1,
  editor: 2,
  manager: 3,
};

@Injectable()
export class KbAccessService {
  constructor(private readonly repo: KbAccessRepository) {}

  /**
   * 解析用户对某知识库的「有效权限」。判定顺序（先命中即返回）：
   * 0a. 按 (orgId, kbId) 查不到知识库行 → null（跨组织拿别人的 kbId 就在这一步被挡下，
   *     对外表现为「库不存在」，不承认它在别的组织里真实存在）
   * 0b. 此人不在该组织的 memberships 里 → null（非成员没有任何继承权限，
   *     连「他当年建的库」也照样进不去：这一步排在创建者判断之前）
   * 1. 组织 owner/admin → manager（管理员穿透，避免把自己锁在门外）
   * 2. 知识库创建者 → manager
   * 3. 显式授权行（knowledge_base_members）→ 其记录的权限
   * 4. 知识库为组织公开（access_mode='org'）→ viewer
   * 5. 以上都不满足 → null（接口按 403/404 处理）
   *
   * 三点值得注意的顺序含义：
   * - 1 在 2 之前：创建者如果只是普通 member，结果仍是 manager，两条规则给出同一个值，
   *   但 owner/admin 即使与这个库毫无关系也永远是 manager
   * - 3 在 4 之前：显式授权优先于组织公开继承，所以「库是 org 模式」时也能给某个人 editor，
   *   但反过来无法用显式授权把 owner/admin 的 manager 压低（1 已经先返回了）
   * - 4 只看 access_mode，不看这个人是否被单独加过：org 模式下全组织成员至少是 viewer
   * 返回 null 不等于「库不存在」，调用方要按 0a/0b 与 5 三种情况统一处理（require 一律 404）
   */
  async resolve(
    orgId: string,
    kbId: string,
    userId: string,
  ): Promise<KbPermission | null> {
    // 判定 0a：库必须在这个组织下；这一步同时把 accessMode 与 createdBy 取回来给后面用
    const kb = await this.repo.getKb(orgId, kbId);
    if (!kb) return null;

    // 判定 0b + 1：先确认成员资格，再让 owner/admin 直接穿透成 manager
    const orgRole = await this.repo.getOrgRole(orgId, userId);
    if (!orgRole) return null;
    if (orgRole === 'owner' || orgRole === 'admin') return 'manager';
    // 判定 2：创建者天生 manager（即使库已切成 restricted、即使他没有任何授权行）
    if (kb.createdBy === userId) return 'manager';

    // 判定 3：显式授权行原样返回，等级可以是 viewer/editor/manager
    const explicit = await this.repo.getMemberPermission(kbId, userId);
    if (explicit) return explicit;
    // 判定 4：组织公开模式兜一层只读；restricted 模式下没被单独授权的人到这里就是 null
    if (kb.accessMode === 'org') return 'viewer';
    return null;
  }

  /**
   * 判定 + 门槛校验：把「有效权限」和「这次操作要什么等级」合成一个可执行的结果。
   * 步骤：
   * 1. resolve 拿有效权限
   * 2. null → 404「知识库不存在或无权访问」：故意用 404 而不是 403，不向圈外人承认这个库存在
   *    （0a 库不在本组织、0b 非成员、5 无授权且 restricted 三种原因在这里对外是同一句话）
   * 3. RANK 比等级：低于门槛 → 403「没有执行此操作的权限」。能走到这一步说明库对他是可达的，
   *    才允许承认「存在但权限不足」——这就是 404/403 的分界线
   * 4. 返回解析出的有效权限（不是传入的 required），调用方可据此决定返回哪些字段
   * 与 KbPermissionGuard 的关系：走的是同一个 resolve 与同一套 404/403 语义，
   * 差别只在门槛来自 @RequireKbPermission 元数据而不是入参。
   * 现役调用方：documents.service（viewer 读 / editor 写）、chat.service（全部 viewer）、
   * realtime.gateway 的 kb:join 与 chat:send（都是 viewer）。
   */
  async require(
    orgId: string,
    kbId: string,
    userId: string,
    required: KbPermission,
  ): Promise<KbPermission> {
    const permission = await this.resolve(orgId, kbId, userId);
    if (!permission) throw new NotFoundException('知识库不存在或无权访问');
    // 步骤 3：只在「可达但等级不够」时报 403
    if (RANK[permission] < RANK[required]) {
      throw new ForbiddenException('没有执行此操作的权限');
    }
    return permission;
  }

  /**
   * 只确认「库在这个组织下」并取回本体字段，不判任何权限：查不到 → 404「知识库不存在」。
   * 用在控制器已经用 @RequireKbPermission 放行之后，服务层再读一次行只为拿 name/description 等字段。
   * 边界要看清：orgId 必须是守卫校验过的路由参数，本方法自己不确认请求者是不是该组织成员，
   * 所以绕过 KbPermissionGuard 直接调用它就能读到别的组织的库元信息——现役三个调用方都在
   * knowledge-bases.service.ts 里，且都挂在带门槛的路由后面。
   */
  async getKbOrThrow(orgId: string, kbId: string): Promise<KbRow> {
    const kb = await this.repo.getKb(orgId, kbId);
    if (!kb) throw new NotFoundException('知识库不存在');
    return kb;
  }
}
