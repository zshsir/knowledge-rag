/**
 * StorageService 单测：守两条不可回退的安全契约——
 * 1. 用户可控的文件名不能变成路径片段（sanitizeFilename 是第一道，storageKey 里不许出现 '..'）
 * 2. absolutePath 的「键 → 绝对路径」出口带路径穿越防护，跑出 root 就 400
 * 边界：不测鉴权（存储层本来就不知道租户，见 storage.service.ts 文件头），
 *      不测 documents/knowledge-bases 的删除流程；用真实的临时目录跑磁盘 IO，
 *      但把 AppConfigService 换成只含 uploadDir 的对象，避免测试去读 .env、也避免写到 UPLOAD_DIR。
 * 已知覆盖缺口：removeDocumentDir 与 removeFile 在本文件里没有用例（前者只在 documents 的
 *      失败回滚/删除路径上被调用，后者 grep 全仓只有定义没有调用方），下方第三条用例的名称容易让人误读。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageService, sanitizeFilename } from './storage.service';

describe('StorageService', () => {
  let root: string;
  let service: StorageService;

  beforeEach(async () => {
    // 每个用例一个独立临时根目录：断言「整棵子树被删净」时不会串到别的用例
    root = await mkdtemp(join(tmpdir(), 'knowledge-rag-storage-'));
    // 假配置只喂 uploadDir；构造函数会 resolve 成绝对路径，作为穿越比较的基准
    service = new StorageService({ uploadDir: root } as never);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // 回归点：`../../evil.txt` 这类名字必须只剩最后一段。这里钉的是第一道闸（净化），
  // 落盘后再读回同一 storageKey，证明净化后的键确实可寻址，不是「名字改了但文件写到别处」
  it('sanitizes filenames and prevents traversal', async () => {
    expect(sanitizeFilename('../../evil.txt')).toBe('evil.txt');
    const saved = await service.save({
      orgId: 'org',
      kbId: 'kb',
      documentId: 'doc',
      filename: '../../evil.txt',
      buffer: Buffer.from('hello'),
    });
    expect(saved.storageKey).toContain('evil.txt');
    expect(saved.storageKey).not.toContain('..');
    await expect(service.readFile(saved.storageKey)).resolves.toEqual(
      Buffer.from('hello'),
    );
  });

  // 回归点：第二道闸（absolutePath 的 resolve-后-再-比较）。注意防护成立的关键是
  // 「先 resolve 再比前缀」，改成「先字符串查 .. 再 resolve」就会被绝对片段绕过
  it('rejects absolute escape paths', () => {
    // 断言刻意只写 .toThrow()：没钉异常类型与文案（实现抛的是 400「非法文件路径」），
    // 换成任何别的异常这里也照样绿——强度不如同目录其它用例，属已知弱断言
    expect(() => service.absolutePath('../../etc/passwd')).toThrow();
  });

  // 回归点：删库要递归清掉该库的整棵上传目录（磁盘不在 DB 事务里，漏了就成孤儿目录）。
  // 用例名叫 "document and kb directories"，但 body 只调了 removeKbDir：
  // removeDocumentDir 的行为此处未覆盖（见文件头缺口说明），按名字理解会高估覆盖面
  it('removes document and kb directories', async () => {
    const saved = await service.save({
      orgId: 'org',
      kbId: 'kb',
      documentId: 'doc',
      filename: 'a.txt',
      buffer: Buffer.from('hello'),
    });
    await expect(service.exists(saved.storageKey)).resolves.toBe(true);
    await service.removeKbDir('org', 'kb');
    await expect(service.exists(saved.storageKey)).resolves.toBe(false);
  });
});
