/**
 * TXT / MD 的解码器：把磁盘上的一坨字节变成「可用的纯文本」，并在内容空得没法入库时报 400。
 *
 * 为什么这个文件还存在（这是本模块最重要的一条历史，动手前请读完）：
 * 一次线上事故——老中文文档（Windows 记事本、老 ERP 导出、GBK 时代的资料）存的不是 UTF-8，
 * 而是 GB18030/GBK。当时只按 UTF-8 读，中文全部变成「锘」「璁句」这类乱码写进了 chunks 表，
 * 检索召回的是乱码片段、前端展示的也是乱码，而且【不报错】，事故是靠用户反馈才发现的。
 * 修复就是现在这条「UTF-8 严格解码失败 → GB18030 回退」的两步。
 *
 * 因此 TXT/MD 刻意不换成 LangChain 的 TextLoader：TextLoader 只有 UTF-8 一条路（可指定 encoding，
 * 但没有「先按 UTF-8 试、失败再换」的机制），拿它读同一份 GB18030 文件会得到
 * 要么抛错、要么一串替换字符的结果，等于把这条已修过的事故原样退回。
 * 迁移方案里这条被明确列为「必须保留的行为契约」（设计文档
 * 2026-10-23-langchain-migration-design.md §2.3「TXT/MD 保留自研解码」，
 * 以及 parser.service.ts 文件头的第一条取舍），e2e 里也有一条用例专门钉它
 * （test/ingestion.e2e-spec.ts 的 'ingests a GB18030 encoded TXT without mojibake'）。
 *
 * 两个编码事实（都用 node 实测过，不是推测）：
 * - GB18030 的中文双字节序列按 UTF-8 严格解码必然抛 TypeError，所以「试 UTF-8」这条判据可靠
 * - UTF-8 的前导 BOM 由 TextDecoder 自己吃掉（默认 ignoreBOM:false），本文件不用再剥一次；
 *   反过来说，同一组 BOM 字节若落到 GB18030 分支会被解成「锘」——只有 UTF-8 支能正确处理 BOM
 *
 * 职责边界：
 * - 只管字节→文本这一件事：不读文件（读磁盘是 StorageService.readFile，由 ParserService 调用后才进来）、
 *   不判扩展名（ParserService.load 的 switch 已经选好了解析器）、不切分、不写库
 * - 抛的是 BadRequestException，语义是「内容问题、永久失败」：入库侧据此决定不再重试
 *   （ingestion.service.ts:141 只把非 400 的错误上抛给 pg-boss），所以这里的 400 文案会被写进 documents.error
 * - PDF/DOCX 不走本文件：它们的文本由各自的 loader 提取，提取不出来时才由 parser.service.ts 判空
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import iconv from 'iconv-lite';
import { normalizeText } from './normalize';

@Injectable()
export class TextParser {
  /**
   * 解码一份 TXT/MD 的原始字节。
   * 步骤：
   * 1. 先按 UTF-8【严格】解码：fatal:true 是关键——默认情况下 TextDecoder 遇到非法字节
   *    会静悄悄地产出 U+FFFD 替换字符，那份内容看着是「读成功了」，实际已经是不可逆的乱码，
   *    还会顺带把 BOM 吃掉
   * 2. 严格解码抛错（实践里是 TypeError）才认定「这不是 UTF-8」，改用 GB18030 重解一次。
   *    GB18030 是 GBK/GB2312 的超集，所以这一支同时覆盖两种老编码；它本身几乎不抛错，
   *    代价是万一字节真是别的编码（如 Big5），这里会得到另一种乱码而不是报错——现状如此，
   *    再往上加猜测式探测属于行为变更，不在本文件范围
   * 3. 统一交给 normalizeText 收行尾与控制字符（见 normalize.ts），保证解码成功与回退两支
   *    产出的文本形状一致，后面的切分器才能按同一套分隔符规则工作
   * 4. 归一化后为空（只有 BOM、只有空白、只有 NUL 这类「有字节没内容」的文件）→ 400，
   *    让这份文档以 failed + 「文档内容为空」落地，而不是切出 0 个片段停在 ready
   * 返回：归一化后的纯文本；非空是后置条件（空的情况一定已经抛出）
   */
  parseBuffer(buffer: Buffer): string {
    let text: string;
    try {
      // 步骤 1：UTF-8 严格解码（fatal:true 才有「失败」可言）
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
      // 步骤 2：失败即判定不是 UTF-8，按 GB18030 重解——这条 catch 就是那次乱码事故的修复本体。
      // 摘掉它会有两处红：单测 parsers.spec.ts:80（走 ParserService.load，storage 是假的）
      // 与 e2e test/ingestion.e2e-spec.ts 的 GB18030 那条（走真磁盘 + 真切分 + 真落库）
      text = iconv.decode(buffer, 'gb18030');
    }
    // 步骤 3：两支共用同一套归一化，避免「UTF-8 文件切得对、GBK 文件切得怪」
    const normalized = normalizeText(text);
    // 步骤 4：空内容的三种来源（空字节、纯空白、只有控制字符）在这里统一收口成 400
    if (!normalized) {
      throw new BadRequestException('文档内容为空');
    }
    return normalized;
  }
}
