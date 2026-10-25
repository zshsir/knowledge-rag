/**
 * 上传文件的入口校验：只看 multer 已经缓冲在内存里的那一份文件，不碰磁盘、不碰数据库。
 *
 * 三层判断，一层比一层严：
 * 1. 形状与体积：文件在不在、有没有名字、字节数是否为 0、是否超过 maxUploadMb
 * 2. 扩展名白名单，以及客户端声明的 MIME 与该扩展名是否自相矛盾
 * 3. magic bytes：PDF/DOCX 按文件头字节判格式——这一层才真正挡住「把 exe 改名成 pdf」
 *
 * 职责边界：
 * - 不判权限：谁能往这个知识库里传文件由 OrgMemberGuard + KbPermissionGuard 决定，
 *   本文件连 orgId/kbId 都拿不到，只认识 file 这一个入参
 * - 不落盘、不解析内容、不切片；除了修 multipart 的中文文件名乱码，不改动文件名
 * - 体积校验省下的是后面的落盘与解析，不省传输与内存：FileInterceptor 默认内存存储，
 *   请求一进来整个文件（包括随后被拒的超限文件）就已经完整缓冲在 buffer 里了
 * - 返回的 extension 来自原始 originalname 而非乱码修复后的名字；扩展名本身是 ASCII，
 *   两种形态下同值。worker 侧另有一次按 storageKey 取扩展名选解析器
 *   （ingestion/parsing/parser.service.ts:18），两份清单内容目前一致（txt/md/pdf/docx），
 *   但没有代码保证它们同步，加一种格式要两处同改
 */
import { BadRequestException } from '@nestjs/common';
import { extname } from 'node:path';

/**
 * 扩展名 → 该扩展名可接受的 MIME 集合。
 * 四种类型都额外允许 application/octet-stream：浏览器与中间代理在非常规场景下常拿它当兜底类型，
 * 严格按「txt 必须声明 text/plain」拦会误伤真实上传。所以这一层只是「别自相矛盾」的弱校验，
 * 真正的格式判断留给下面的 magic bytes。
 */
const ALLOWED: Record<string, string[]> = {
  '.txt': ['text/plain', 'application/octet-stream'],
  '.md': ['text/markdown', 'text/plain', 'application/octet-stream'],
  '.pdf': ['application/pdf', 'application/octet-stream'],
  '.docx': [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/octet-stream',
  ],
};

/**
 * 校验通过的产出。目前只带一个小写扩展名——校验器刻意不返回文件内容、大小或 MIME，
 * 调用方（documents.service）手上本来就有 multer 给的那份 file，没必要再抄一遍。
 */
export interface ValidatedUpload {
  extension: string;
}

/**
 * 修复 multipart 上传的中文文件名乱码。这是修过的线上事故，改这个函数前请先读完这段。
 * 背景：浏览器在 multipart 体里按 UTF-8 发文件名，busboy 可能按 latin1 逐字节解码，
 * 于是「报告.docx」里每个汉字的 3 个 UTF-8 字节被解成 3 个 U+0080–U+00FF 的乱码字符。
 * 步骤：
 * 1. 空串直接原样返回——没什么可修的，也避免把空名字送进后面的解码
 * 2. 只要出现码点 > 0xFF 的字符，说明这份名字已经是正确解码的 Unicode（汉字、emoji 都算），
 *    立即原样返回：再解码一次就是二次误解码，会把本来正确的名字弄坏
 * 3. 全程落在 0x00–0xFF 区间才按 latin1 → utf8 重新解码（把字符当字节还原，再按 UTF-8 解释）
 * 4. 解码结果里出现 U+FFFD（替换字符）说明第 3 步猜错了，返回原值，绝不返回更坏的结果
 *
 * 第 2 步为什么是「有任何一个 > 0xFF 就收手」而不是统计比例：乱码是整串字节级的现象，
 * 一个真汉字（码点远大于 0xFF）就足以证明这串已经是解码好的 Unicode，此时整串都不该再动。
 *
 * 两点如实的取舍：
 * - 第 4 步真正保住的是「码点全落在 latin1 区间但本来就是对的」名字，例如 café.pdf 里的 é（U+00E9）：
 *   它过得了第 2 步，按 latin1 编回去再当 UTF-8 读只得到 U+FFFD，靠第 4 步回退才没被改坏
 *   （document-validation.spec.ts 第二条用例钉的就是这个行为）
 * - 反过来，真乱码但重新解码恰好也产出 U+FFFD 的名字会留在乱码态。这是刻意的保守：
 *   返回原值最差只是「维持现状」，返回猜错的值则是把名字改坏
 */
export function normalizeUploadFilename(name: string): string {
  // 步骤 1：空串短路
  if (!name) return name;
  // Array.from 按码点切，所以 emoji 这类增补平面字符是一个元素而不是两个代理项
  const codePoints = Array.from(name).map((char) => char.codePointAt(0)!);
  // 步骤 2：已经是正确 Unicode 的名字在此收手
  if (codePoints.some((code) => code > 0xff)) return name;
  // 步骤 3：latin1 视角的字符 → 原始字节 → 按 UTF-8 重新解释
  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  // 步骤 4：出现替换字符就是猜错了，回退原值
  return decoded.includes('\uFFFD') ? name : decoded;
}

/**
 * 上传文件的总校验。任一条不过就抛 BadRequestException（400，中文文案原样给前端展示），
 * 全过才返回 { extension }。
 * 步骤：
 * 1. 存在性与基本形状：没带文件 / 文件名为空 / size <= 0
 * 2. 体积：size 超过 maxUploadMb 换算出的字节数就拒（中文 400）。这只是第二道闸，
 *    controller 的 FileInterceptor 另有一个写死的 25MB multer 上限，
 *    两道闸的先后与各自的状态码见 documents.controller.upload 的注释
 * 3. 扩展名必须命中 ALLOWED 白名单（先 toLowerCase，大小写不敏感）
 * 4. 客户端声明了 mimetype 时，必须落在该扩展名的可接受集合里；mimetype 为空则跳过这一层
 * 5. PDF 查前 5 字节是否 "%PDF-"，DOCX 查前 4 字节是否 ZIP 本地文件头 "PK\x03\x04"
 *    （txt/md 没有可靠的文件签名，所以这两类不做第 5 步）
 * 6. 返回小写扩展名
 *
 * 第 5 步只保证「是个 PDF 容器 / 是个 zip」：docx 内部是不是合法 OOXML，要等 worker 解析时才见分晓，
 * 那时失败会写成文档的 failed 状态，不在这里报 400。
 */
export function validateUpload(
  file: Express.Multer.File | undefined,
  maxUploadMb: number,
): ValidatedUpload {
  // 步骤 1：三条形状检查——注意 multer 在未带 file 字段时给的是 undefined，不是空对象
  if (!file) throw new BadRequestException('请选择要上传的文件');
  if (!file.originalname) throw new BadRequestException('文件名不能为空');
  if (file.size <= 0) throw new BadRequestException('文件内容为空');
  // 步骤 2：MB → 字节，与配置项的单位约定在这里换算一次
  if (file.size > maxUploadMb * 1024 * 1024) {
    throw new BadRequestException(`文件不能超过 ${maxUploadMb}MB`);
  }

  // 步骤 3：扩展名白名单；extname 只取最后一段后缀，无后缀的文件在这里就出局
  const extension = extname(file.originalname).toLowerCase();
  const allowedMimes = ALLOWED[extension];
  if (!allowedMimes) {
    throw new BadRequestException('仅支持 TXT、MD、PDF、DOCX 文件');
  }
  // 步骤 4：只在客户端确实声明了类型时才比对声明与后缀是否矛盾
  if (file.mimetype && !allowedMimes.includes(file.mimetype)) {
    throw new BadRequestException('文件类型与扩展名不匹配');
  }

  // 步骤 5：magic bytes 直接读 buffer 头部，此时文件已在内存，无需额外 IO
  if (extension === '.pdf') {
    const magic = file.buffer.subarray(0, 5).toString('latin1');
    if (magic !== '%PDF-') {
      throw new BadRequestException('PDF 文件格式不正确');
    }
  }
  if (extension === '.docx') {
    const magic = file.buffer.subarray(0, 4);
    if (!magic.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
      throw new BadRequestException('DOCX 文件格式不正确');
    }
  }

  // 步骤 6：只有全部通过才产出 extension
  return { extension };
}
