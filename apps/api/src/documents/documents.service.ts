/**
 * 文档业务层：上传、列表、分片查看、下载、删除、重试六个操作的规则都在这里。
 *
 * 分工（本文件自己既不发 SQL 也不写磁盘）：
 * - SQL 在 DocumentsRepository：除 insert 外每条语句都自带 org_id 过滤，那是租户硬边界
 * - 磁盘在 StorageService：它只认 storageKey，不认识「人」，路径安全与穿越防护也在那边
 * - 权限在 KbAccessService.require：每次现查、不缓存，所以改权限立刻生效
 * - 异步任务在 QueueService：本进程只投递，消费在 worker 进程
 *
 * 两条贯穿全文件的规矩：
 * 1. 「凭 documentId 操作」的四个方法（listChunks / download / remove / retry）都是同一个开场三步：
 *    先按 (orgId, documentId) 取行 → 判权限 → 才碰数据。顺序不能反，因为权限判定要用的 kb_id
 *    就在那一行里，不先取行根本不知道该判哪个库的权限。取不到行一律 404，
 *    跨组织拿别人的 documentId 与「真的不存在」对外是同一句话，不承认前者真实存在
 * 2. 交给前端的文档一律先去掉 storageKey（见 publicDocument）
 *
 * 不做：解析文本、切分、算向量（worker 里 ingestion 的事）；不轮询任务进度；
 * 也不做「列表可见性」以外的批量操作——删除与重试都是单文档粒度。
 */
import {
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AppConfigService } from '../config/config.service';
import { StorageService } from '../storage/storage.service';
import { KbAccessService } from '../knowledge-bases/kb-access.service';
import { DocumentsRepository, DocumentRow } from '../database/repositories/documents.repository';
import { QueueService } from '../queue/queue.service';
import { normalizeUploadFilename, validateUpload } from './document-validation';

/**
 * 把 documents 行裁成可外发的形状：只摘掉 storageKey（它是磁盘相对路径，
 * 交给前端等于把内部目录拼法 orgs/{org}/knowledge-bases/{kb}/documents/{id}/{name} 和盘上
 * 真实文件名一起暴露出去，还能让外人看出 ID 之间的归属关系），其余字段原样浅拷贝。
 * 三个出口共用：list、upload、retry 的返回值。
 */
function publicDocument(document: DocumentRow) {
  const { storageKey: _storageKey, ...rest } = document;
  return rest;
}

@Injectable()
export class DocumentsService {
  constructor(
    private readonly repo: DocumentsRepository,
    private readonly storage: StorageService,
    private readonly kbAccess: KbAccessService,
    private readonly config: AppConfigService,
    private readonly queue: QueueService,
  ) {}

  /**
   * 列出某知识库的文档。步骤只有两步，因为门槛不在这里：
   * 1. 按 (orgId, kbId) 取全部行（created_at 倒序，仓储里写死）
   * 2. 逐行去掉 storageKey 后返回
   * 权限为什么可以不判：这条路由的路径里带 :kbId，控制器挂了 @RequireKbPermission('viewer')，
   * KbPermissionGuard 已经在进服务之前判过并放行；本方法拿到的 orgId/kbId 就是守卫校验过的那对。
   * 反过来，下面几个只带 :documentId 的方法必须自己判——原因见各自的注释。
   */
  async list(orgId: string, kbId: string) {
    const documents = await this.repo.listForKb(orgId, kbId);
    return documents.map(publicDocument);
  }

  /**
   * 上传一份原始文档：校验 → 落盘 → 建 documents 行（status=queued）→ 投递 pg-boss 任务。
   * 这个顺序是刻意的，每一步各挡一类问题：
   * 1. validateUpload 最先跑：格式或体积不合格的既不留目录也不写库，一步脏数据都不产生
   * 2. normalizeUploadFilename 修文件名乱码：修好的名字同时用于磁盘文件名与库里的 filename 列，
   *    两边必须同一个值，否则下载时按 filename 起的名字与实际文件对不上
   * 3. documentId 在此就地 randomUUID：磁盘路径与数据库行共用同一个 id，
   *    「documents/{documentId}/」这个拼法才能反查到行，失败时也能按同一个 id 精确回滚
   * 4. storage.save 落盘（先盘后库）：库里那条记录的业务含义就是「文件已经在盘上等入库」，
   *    worker 只认库里的状态，不会去猜磁盘上有什么
   * 5. repo.insert 建行：状态 'queued' 写在 SQL 里（documents.repository.insert），本层不传
   * 6. queue.sendDocument 投递：这一步成功才对用户返回 queued
   * 7. 投递失败：把行改成 failed 并写错误文案（不让它永远停在 queued 让前端干转圈），
   *    再抛 503；这个异常落到外层 catch，删掉刚建的文档目录，回滚顺序与建立顺序相反
   * 8. 外层 catch 同时覆盖第 5 步失败的情况：建行失败（如库挂了）也把已落盘的目录删干净再抛出
   *
   * 边界与已知残留（都按现状记录，不在这里改）：
   * - 落盘与建行不在同一事务：进程恰好在这两步之间被杀，磁盘上会留下一个没有数据库行对应的目录，
   *   没有任何地方会清它（清理全靠 documentId 去库里找行）
   * - API 进程只投不消费：IngestionProcessor 只注册在 WorkerModule，所以这里返回的 queued
   *   要等 worker 进程拉起才会推进；worker 没跑时文档会永远停在 queued
   * - 权限判定不在这里：能不能上传由控制器的 @RequireKbPermission('editor') 决定，
   *   本方法相信传进来的 orgId/kbId/userId 都是守卫校验过的
   */
  async upload(input: {
    userId: string;
    orgId: string;
    kbId: string;
    file?: Express.Multer.File;
  }) {
    const file = input.file;
    validateUpload(file, this.config.maxUploadMb);
    // 只为 TypeScript 收窄类型：validateUpload 已对 undefined 抛 400，这一行实际不可达，
    // 但去掉后 file 在后续代码里仍是可选类型，编译不过
    if (!file) throw new NotFoundException('文件不存在');

    // 步骤 2+3：先修名字再定 id，两者同处一步算完，让「磁盘目录名」与「库里的 filename」来自同一份计算
    const filename = normalizeUploadFilename(file.originalname);
    const documentId = randomUUID();
    // 步骤 4：落盘，返回的 storageKey 是唯一一个不外发给前端、但必须原样进库的字段
    const saved = await this.storage.save({
      orgId: input.orgId,
      kbId: input.kbId,
      documentId,
      filename,
      buffer: file.buffer,
    });

    try {
      // 步骤 5：写库；sizeBytes 取内存 buffer 的字节数，不重新 stat 磁盘文件
      const document = await this.repo.insert({
        id: documentId,
        orgId: input.orgId,
        kbId: input.kbId,
        uploadedBy: input.userId,
        filename,
        mimeType: file.mimetype,
        sizeBytes: saved.sizeBytes,
        storageKey: saved.storageKey,
      });
      try {
        // 步骤 6：投递。任务负载只带四个 id，不带文件内容——worker 按 storageKey 自己回读磁盘
        await this.queue.sendDocument({
          documentId: document.id,
          orgId: document.orgId,
          kbId: document.kbId,
          uploadedBy: input.userId,
        });
      } catch (error) {
        // 步骤 7：入队失败 → 行标 failed + 503，抛出的异常交给外层做磁盘回滚
        await this.repo.updateStatus(
          input.orgId,
          document.id,
          'failed',
          '任务入队失败，请稍后重试',
        );
        throw new ServiceUnavailableException(
          error instanceof Error ? error.message : '任务入队失败',
        );
      }
      return publicDocument(document);
    } catch (error) {
      // 步骤 8：库侧任何失败都删掉整个文档目录（recursive + force，目录不存在也不报错）后原样抛出
      await this.storage.removeDocumentDir(input.orgId, input.kbId, documentId);
      throw error;
    }
  }

  /**
   * 查看某文档切分出来的片段（前端「查看分片」页）。
   * 步骤：1. 按 (orgId, documentId) 取行，取不到 → 404 2. require(viewer) 3. 才查 chunks
   * viewer 前置为什么必须写在这里而不是控制器上：这条路由的路径是
   * orgs/:orgId/documents/:documentId/chunks，没有 :kbId，而 KbPermissionGuard 拿不到 kbId 时
   * 只会抛 404「知识库不存在」——判不了。只能先取行拿到 document.kbId，再交给 require。
   * 门槛取 viewer 而非 editor：分片正文就是知识库内容本身，只读资格即足够。
   * 兜底：chunks 表冗余了 org_id，仓储层再带一次 org 条件，即使上面判错也捞不到别人的片段。
   */
  async listChunks(userId: string, orgId: string, documentId: string) {
    // 步骤 1：先定位文档，才谈得上定位它的库
    const document = await this.repo.findById(orgId, documentId);
    if (!document) throw new NotFoundException('文档不存在');
    // 步骤 2：权限前置在这一步，早于任何 chunks 查询
    await this.kbAccess.require(orgId, document.kbId, userId, 'viewer');
    // 步骤 3：过了门槛才读正文片段
    return this.repo.listChunks(orgId, documentId);
  }

  /**
   * 下载原始上传文件。步骤：
   * 1. 取行 → 404
   * 2. require(viewer)：与 listChunks 同一形状，同样是「先判资格再碰文件」——
   *    注意这一步排在任何磁盘操作之前，不存在「先 stat 再问权限」的写法
   * 3. storage.absolutePath 把 storageKey 换成绝对路径（可能抛 400「非法文件路径」）
   * 4. exists 确认文件还在 → 不在则 404「原文件不存在」
   * 5. 返回绝对路径 + 文件名，由控制器交给 res.download
   * 第 3、4 步的先后是现状：库里 storageKey 被写坏时用户看到的是 400 而不是 404。
   * filename 用库里的值而不是磁盘路径里的名字，前者是乱码修复后的正确写法。
   */
  async download(userId: string, orgId: string, documentId: string) {
    const document = await this.repo.findById(orgId, documentId);
    if (!document) throw new NotFoundException('文档不存在');
    // 步骤 2：权限前置
    await this.kbAccess.require(orgId, document.kbId, userId, 'viewer');
    const absolutePath = this.storage.absolutePath(document.storageKey);
    const exists = await this.storage.exists(document.storageKey);
    if (!exists) throw new NotFoundException('原文件不存在');
    return { absolutePath, filename: document.filename };
  }

  /**
   * 删除一个文档（元数据 + 磁盘文件）。步骤：
   * 1. 取行 → 404  2. require(editor)：删除是写操作，门槛比看高一档
   * 3. repo.delete 删 documents 行；chunks 靠外键 ON DELETE CASCADE 一并清掉，
   *    所以本层不写删切片的 SQL
   * 4. storage.removeDocumentDir 递归删该文档的目录
   * 顺序是先库后盘，两步不在同一事务：第 4 步失败（权限、磁盘）会留下「库里没行、盘上有文件」
   * 的孤儿目录，且此后无人再清它。反过来的话会留下「库里有行、盘上没文件」的更坏状态
   * ——行会被列表页显示成可下载但永远 404，所以现状选了先删库。
   * 不发任何实时通知：删文档不改变任何人的知识库权限（回收事件是给「权限变了」用的），
   * 代价是其他人正打开的列表页会留着一行已删文档，直到下次 refetch 才消失。
   */
  async remove(userId: string, orgId: string, documentId: string) {
    const document = await this.repo.findById(orgId, documentId);
    if (!document) throw new NotFoundException('文档不存在');
    // 步骤 2：editor 门槛（viewer 只能看，不能删）
    await this.kbAccess.require(orgId, document.kbId, userId, 'editor');
    await this.repo.delete(orgId, documentId);
    // 步骤 4：磁盘收尾
    await this.storage.removeDocumentDir(orgId, document.kbId, documentId);
    return { ok: true };
  }

  /**
   * 重新入库一个文档（失败重试，也可对已就绪的文档强制重跑）。步骤：
   * 1. 取行 → 404  2. require(editor)
   * 3. 只挡 status='processing' → 409：同一文档排进两个任务时，两个 worker 会各自开事务
   *    对同一批 chunks 先 DELETE 再 INSERT（见 ingestion.service.process），结果不可预期，所以必须挡；
   *    其余状态（queued / ready / failed）都放行——ready 的文档也能靠这个按钮重跑
   * 4. repo.requeue 把状态改回 queued、清掉 error（UPDATE ... RETURNING，没命中行则 null → 404）
   * 5. queue.sendDocument 投递
   * 6. 投递失败：与 upload 同样处理——行改回 failed 写错误文案，再抛 503
   * 与 upload 的关键差别：这里不碰磁盘。文件已经在原地，重试只需要重排任务，
   * 所以失败时也不需要回滚目录（第 6 步只改库状态，不删文件）。
   * uploadedBy 取库里的历史值，取不到才退回当前操作人：任务负载里的这个 id 会决定
   * document:status 推给谁，用原作者比用「点了重试的人」更符合前端预期。
   */
  async retry(userId: string, orgId: string, documentId: string) {
    const document = await this.repo.findById(orgId, documentId);
    if (!document) throw new NotFoundException('文档不存在');
    await this.kbAccess.require(orgId, document.kbId, userId, 'editor');
    // 步骤 3：唯一的并发保护，别的状态一律放行
    if (document.status === 'processing') {
      throw new ConflictException('文档正在处理中');
    }
    // 步骤 4：先把行改成 queued 再投递。反过来的话会出现「任务已在队列里、库里却还写着 failed/ready」，
    // 前端会一边显示终态一边看到文档被重跑；先改库还能保证投递失败时第 6 步有明确的回写目标
    const queued = await this.repo.requeue(orgId, documentId);
    if (!queued) throw new NotFoundException('文档不存在');
    try {
      // 步骤 5：投递新任务。旧的 job 如果还躺在队列里不会被撤销（见 queue.service 里 singletonKey 的说明）
      await this.queue.sendDocument({
        documentId: queued.id,
        orgId: queued.orgId,
        kbId: queued.kbId,
        uploadedBy: queued.uploadedBy ?? userId,
      });
    } catch (error) {
      // 步骤 6：入队失败 → 状态回到 failed + 503
      await this.repo.updateStatus(
        orgId,
        documentId,
        'failed',
        '任务入队失败，请稍后重试',
      );
      throw new ServiceUnavailableException(
        error instanceof Error ? error.message : '任务入队失败',
      );
    }
    return publicDocument(queued);
  }
}
