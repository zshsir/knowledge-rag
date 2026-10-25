/**
 * 本地磁盘存储：把上传的原始文件按固定层级放到 UPLOAD_DIR 下，并只用一个字符串键（storageKey）寻址。
 * 目前没有对象存储/网盘后端，storageKey 就是唯一的外部标识，它被存进 documents.storage_key 列，
 * worker 与删除流程都靠它回定位文件。
 *
 * 键的形状（posix 风格，永远是 / 分隔，与运行平台无关）：
 *   orgs/{orgId}/knowledge-bases/{kbId}/documents/{documentId}/{safeName}
 * 存成 posix 而读取时再按当前平台 resolve，是为了让库里的值可移植（换机器、换容器、Windows 开发机都不需要迁移数据）。
 *
 * 安全边界（本文件的核心，不是一个普通工具类）：
 * - absolutePath 是唯一的「键 → 绝对路径」出口，读写删六个方法（save / readFile / exists /
 *   removeFile / removeDocumentDir / removeKbDir）全部经过它，
 *   它带路径穿越防护：resolve 之后必须仍落在 root 之内，否则 400「非法文件路径」
 * - sanitizeFilename 只负责「文件名里不许带路径分隔符和 ..」，是拼键之前的第一道；
 *   两者独立生效，去掉任何一道都留一条通路
 *
 * 职责边界：
 * - 不鉴权：它只认 storageKey，完全不知道「这个人能不能读这个文件」。
 *   租户与角色判定在调用方（documents.service 用 KbAccessService.require，ingestion 按库里的 storageKey 取）
 * - 不查数据库、不校验扩展名或 MIME（那是 document-validation 与 parser 的事）、不做病毒扫描
 * - 不保证原子性与一致性：写完文件与写完库行是两个动作，孤儿目录无人回收
 * - 不做容量管理与配额：磁盘写满直接抛 IO 错误，由调用方变成 500
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, basename, resolve, sep } from 'node:path';
import { posix } from 'node:path';
import { AppConfigService } from '../config/config.service';

/**
 * 把用户上传的文件名收敛成一个可以安全当作路径片段的名字。
 * 步骤：
 * 1. 先把反斜杠统一成 /，再取 basename：这样 Windows 客户端送来的 C:\a\b.txt 或
 *    ..\..\evil.txt 都只剩下最后一段 b.txt / evil.txt，目录部分整体消失
 * 2. 删掉控制字符（\u0000–\u001f 与 \u007f）：它们不能进文件名，且会污染前端展示与日志
 * 3. 删掉所有 .. ：第 1 步之后正常不会剩下，这一步是防「....//」这类拼接出来的花样（纵深防御）
 *    注意它只删连续的两个点，单个点（如 .gitignore 这种名字）会留下
 * 4. trim 空白；结果为空串则退化成 'document'——绝不允许产生空路径片段（那会指向上一层目录）
 * 5. 截到 200 字符：给极端长的名字封顶，避免撑爆文件系统单段 255 字节的限制
 * 已知代价：第 5 步是硬截断，名字过长时可能把扩展名切掉，下游 parser 按扩展名选解析器
 * 就会落到 default 分支报「不支持的文档格式」，文档表现为入库 failed。
 * 它不做的事：不改扩展名、不折叠大小写、不保证唯一（同名文件靠上一层的 documentId 目录隔开）。
 */
export function sanitizeFilename(filename: string): string {
  // 步骤 1：先规范化分隔符再取最后一段，目录部分整体消失
  const base = basename(filename.replace(/\\/g, '/'));
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\.\./g, '')
    .trim();
  // 步骤 4+5：空名兜底，长名截断
  return (cleaned || 'document').slice(0, 200);
}

@Injectable()
export class StorageService {
  private readonly root: string;

  constructor(config: AppConfigService) {
    // 只在这里读一次配置：root 之后不再变，absolutePath 的前缀比较才有一个稳定基准。
    // resolve() 让 UPLOAD_DIR 写成 ./storage 这类相对路径也能用（相对进程工作目录展开成绝对路径）
    this.root = resolve(config.uploadDir);
  }

  /**
   * 把 storageKey 换成绝对路径，并完成路径穿越防护——这是安全边界，不是工具函数。
   * 步骤：
   * 1. 按 '/' 切开键，展开成 resolve 的多个参数一起规范化：resolve 会就地消化 .. 与 . 段，
   *    得到「绝对且规范化」的结果，后续比较才有意义
   * 2. 判定结果是否仍在 root 之内：等于 root 本身，或以 root + 分隔符 开头才算通过
   * 3. 否则抛 400「非法文件路径」
   *
   * 四个必须留意的点：
   * - 第 1 步「先规范化再比较」是这套防护成立的前提。反过来先做字符串检查再 resolve，
   *   就会被重复斜杠、./.. 组合，以及「键里出现绝对片段」这些花样绕过——
   *   node 的 resolve 遇到以 / 开头的片段会直接丢弃之前的 base，返回 /etc/passwd 这种结果，
   *   所以「root 拼在前面」不等于「结果在 root 里」。先 resolve 再比较则把这些写法统统收敛成唯一形态
   * - 第 2 步的比较基准要补一个分隔符再 startsWith：root=/data/storage 时，
   *   /data/storage-evil/x 也满足 startsWith('/data/storage')，不补 sep 就放行了兄弟目录
   * - 允许「正好等于 root」是现状：所有真实的键都带 orgs/... 前缀，实际不会走到等于 root 这一支，
   *   留着它只是让判断式少一个特例，对本服务的方法没有可达路径
   * - 防护粒度要看清：它管的是「不许跑到 root 外面」，不管「这个键属不属于当前租户」。
   *   租户边界来自调用方传的 orgId 与权限判定，别把这里当多租户隔离层
   * 抛出的是 400 而不是 500：把「库里的键被写坏了」当成请求非法来对外表述，不外泄 root 路径。
   */
  absolutePath(storageKey: string): string {
    const absolute = resolve(this.root, ...storageKey.split('/'));
    // 步骤 2：比较基准补分隔符，挡住兄弟目录
    const rootPrefix = this.root.endsWith(sep) ? this.root : `${this.root}${sep}`;
    if (absolute !== this.root && !absolute.startsWith(rootPrefix)) {
      throw new BadRequestException('非法文件路径');
    }
    return absolute;
  }

  /**
   * 落盘一份上传的原始文件。步骤：
   * 1. sanitizeFilename 把用户给的名字压成安全片段
   * 2. posix.join 拼出 storageKey（键用 / 分隔，与平台无关）
   * 3. absolutePath 走一次防护（写路径与读路径共用同一道闸，不搞「写的时候不校验」）
   * 4. mkdir(recursive) 建到 documentId 那一层，再 writeFile 一次性写整个 buffer
   * 5. 返回 { storageKey, sizeBytes }
   * 注意 sizeBytes 取的是内存 buffer 的字节数，不回读磁盘确认写成功——写完即认为写成功，
   * 磁盘满等 IO 错误会以普通异常抛出，由调用方变 500。
   * 目录层级里 orgId/kbId/documentId 三段由调用方保证是 UUID（路由上的 ParseUUIDPipe 与 randomUUID），
   * 所以本方法只把用户可控的那一段（文件名）拿去做净化。
   */
  async save(input: {
    orgId: string;
    kbId: string;
    documentId: string;
    filename: string;
    buffer: Buffer;
  }): Promise<{ storageKey: string; sizeBytes: number }> {
    const safeName = sanitizeFilename(input.filename);
    // 步骤 2：键的形状见文件头
    const storageKey = posix.join(
      'orgs',
      input.orgId,
      'knowledge-bases',
      input.kbId,
      'documents',
      input.documentId,
      safeName,
    );
    const absolute = this.absolutePath(storageKey);
    // 步骤 4：只建到文件所在目录， writeFile 会覆盖同名文件（同 documentId 目录下不会撞名）
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, input.buffer);
    return { storageKey, sizeBytes: input.buffer.byteLength };
  }

  /**
   * 按 storageKey 回读整个文件（worker 解析时走这里，见 ParserService.load）。
   * 整份读进内存，不流式：与上传时 multer 的内存存储保持同一量级，也才让 parser 那层能直接拿 Buffer。
   * 文件不存在时抛 ENOENT 风格的原始异常，本层不翻译成 404——调用方是后台任务，没有对外文案可言。
   */
  readFile(storageKey: string): Promise<Buffer> {
    return readFile(this.absolutePath(storageKey));
  }

  /**
   * 文件是否存在。任何异常（不存在、没权限、键非法导致的 400）都归一成 false：
   * 调用方 documents.service.download 靠它决定回不回 404，不希望为了「存储层炸了」把用户请求打挂。
   * 代价是真的权限问题时也报「原文件不存在」。
   */
  async exists(storageKey: string): Promise<boolean> {
    try {
      await access(this.absolutePath(storageKey), constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 删单个文件。force:true 让「本来就不存在」不算错误，因此可重复调用。
   * 目前全仓没有调用方（删除都走 removeDocumentDir / removeKbDir 的整目录清理），保留以备单文件回收。
   */
  async removeFile(storageKey: string): Promise<void> {
    await rm(this.absolutePath(storageKey), { force: true });
  }

  /**
   * 递归删掉某个文档的整个目录（键只拼到 documentId 一层，不含文件名）。
   * 两个使用场景：documents.service.upload 的失败回滚，与 documents.service.remove 的正常删除。
   * recursive + force：目录里有多个文件也一次删净，目录不存在时静默成功。
   * 这三段 id 不过 sanitizeFilename，护栏在别处：绝对路径检查只保证「结果仍在 root 之内」，
   * 并不保证「只删该删的那一层」——假如 documentId 里带 ../ 且拼完仍在 root 内，
   * 这里就会把整个父目录递归删掉。真正挡住这件事的是路由上的 ParseUUIDPipe
   * （documents.controller 的 :documentId/:kbId 都带）与「值取自库里的行」这两个前提，
   * 所以新增调用方时必须自己保证传进来的是 UUID 形状的段。
   */
  async removeDocumentDir(
    orgId: string,
    kbId: string,
    documentId: string,
  ): Promise<void> {
    const key = posix.join(
      'orgs',
      orgId,
      'knowledge-bases',
      kbId,
      'documents',
      documentId,
    );
    await rm(this.absolutePath(key), { recursive: true, force: true });
  }

  /**
   * 递归删掉某个知识库的全部上传目录（orgs/{org}/knowledge-bases/{kb} 整棵子树）。
   * 唯一调用方是 knowledge-bases.service.remove：那边数据库靠外键 ON DELETE CASCADE 清 documents/chunks，
   * 但磁盘不在事务里，必须显式调这里，否则删库会留下一堆无人认领的目录。
   * 与 DB 侧不构成原子操作：这一步失败就只留下孤儿目录，不会回滚已经删掉的库与文档行。
   */
  async removeKbDir(orgId: string, kbId: string): Promise<void> {
    const key = posix.join('orgs', orgId, 'knowledge-bases', kbId);
    await rm(this.absolutePath(key), { recursive: true, force: true });
  }
}
