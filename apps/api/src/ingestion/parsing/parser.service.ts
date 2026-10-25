/**
 * 文档解析层：把上传的原文件读成 LangChain 的 Document（纯文本 + metadata）。
 * 边界：只负责「读出一个文档」，不切分（splitter）、不嵌入（EmbeddingsService）、不写库。
 * 三种格式的取舍：
 * - TXT/MD：不能用 LangChain TextLoader（只按 UTF-8 读），保留自研解码以支持 GB18030 回退，
 *           解码结果再包成 Document，从而与后续 LangChain 流程衔接
 * - PDF：用 PDFLoader 提取文本，但页数上限与超时由 pdf-pages.ts 在外面守着
 * - DOCX：用 DocxLoader（底层同样是 mammoth），再做归一化与空内容校验
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import { Document } from '@langchain/core/documents';
import { DocxLoader } from '@langchain/community/document_loaders/fs/docx';
import { PDFLoader } from '@langchain/community/document_loaders/fs/pdf';
import { extname } from 'node:path';
import { StorageService } from '../../storage/storage.service';
import { TextParser } from './text.parser';
import { normalizeText } from './normalize';
import {
  assertPdfPageCount,
  PDF_PARSE_TIMEOUT_MS,
  withTimeout,
} from './pdf-pages';

/**
 * PDF 正文长度下限：归一化后短于这个长度就认为「没有可用文本」（扫描件、空白页）。
 * 只作用于 PDF——这是扫描件检测；TXT/MD 与 DOCX 沿用旧契约，只拒绝空内容，
 * 短备忘录（如 10 个字）仍应正常入库。
 */
const MIN_TEXT_LENGTH = 20;

@Injectable()
export class ParserService {
  constructor(
    private readonly storage: StorageService,
    private readonly textParser: TextParser,
  ) {}

  /**
   * 读取原文件并产出 Document 列表。
   * 步骤：
   * 1. 按扩展名分派；未知格式直接 400（上传接口已有白名单，这里是第二道防线）
   * 2. 提取正文文本（各格式策略见文件头）
   * 3. 统一归一化，并为「loader 返回空串」兜底判空（TXT/MD 已在解码层判过，
   *    这里防的是其它格式的 loader 静默返回空内容）
   * 4. 包成单个 Document 返回，metadata.source 记录 storageKey（含文件名）便于引用展示
   * 返回数组而不是单个 Document：这是 LangChain loader 的通用形态，切分器直接接得上。
   * 注意：20 字符下限只在 PDF 分支生效（见 MIN_TEXT_LENGTH），本方法不再按格式统一卡长度。
   */
  async load(storageKey: string): Promise<Document[]> {
    const extension = extname(storageKey).toLowerCase();
    let text: string;

    switch (extension) {
      case '.txt':
      case '.md': {
        // 自研解码：UTF-8 严格失败则按 GB18030 解，避免中文文档乱码
        text = this.textParser.parseBuffer(
          await this.storage.readFile(storageKey),
        );
        break;
      }
      case '.pdf':
        // loader 只接受路径，且 absolutePath 是唯一的键→路径出口（含穿越校验）；
        // 同时把 storageKey 传进去，页数探测用带校验的 readFile 读同一份字节
        text = await this.loadPdf(
          storageKey,
          this.storage.absolutePath(storageKey),
        );
        break;
      case '.docx':
        text = await this.loadDocx(this.storage.absolutePath(storageKey));
        break;
      default:
        throw new BadRequestException('不支持的文档格式');
    }

    const normalized = normalizeText(text);
    // 兜底判空：各格式内部已分别判过（TXT/MD 在 TextParser，PDF/DOCX 在各自提取方法里）
    if (!normalized) {
      throw new BadRequestException('文档未包含可提取文本');
    }
    return [
      new Document({
        pageContent: normalized,
        metadata: { source: storageKey },
      }),
    ];
  }

  /**
   * PDF 提取。
   * 步骤：
   * 1. 先只读元数据拿页数（比整篇解析便宜），超限立刻拒绝，避免大文件吃满内存
   * 2. 用 PDFLoader 按页解析（splitPages:true 才能拿到每页边界）
   * 3. 页内文本用两个换行拼接（保留段落边界，供下游切分器按 \n\n 优先切分），再归一化
   * 4. 归一化后短于 MIN_TEXT_LENGTH 视为扫描件，抛带 PDF 前缀的 400
   * 5. 任何非业务异常（含元数据探测失败、解析超时）统一包成 400，
   *    让队列按「永久失败」处理而不是无限重试；页数超限/无文本的 400 原样上抛
   * 注意：探测与正文各算一次 60s 超时，不是整篇的总预算。
   * 注意：超时只约束本次等待，不会取消底层 pdf.js 解析——PDFLoader 不交出它内部的 PDFParse
   *      实例，它自己的 finally 只在 getText/getInfo 落定后才 destroy
   *      （@langchain/community 1.1.29 的 document_loaders/fs/pdf.js:132-134），
   *      所以我们这边超时之后，解析仍会自己跑完并继续持有 buffer。
   *      这是相对「已删除的旧 PdfParser」（它在 finally 里立刻 parser.destroy() 打断在途解析）
   *      的已知回归；B8 删除旧实现时的重新评估结论是「本任务不补」：那是行为变更、
   *      需要新测试。要补的话改法很小——正文这一步别再用 PDFLoader，直接用上面探测阶段
   *      已经 import 进来的 PDFParse，就能在自己的 finally 里 destroy。
   *      风险目前只受页数上限（200 页）约束，注意它约束的是页数而不是字节数。
   */
  private async loadPdf(
    storageKey: string,
    absolute: string,
  ): Promise<string> {
    try {
      const { PDFParse } = await import('pdf-parse');
      // 探测读字节走带穿越校验的 readFile，不另开绕过 absolutePath 的入口
      const probe = new PDFParse({
        data: await this.storage.readFile(storageKey),
      });
      try {
        const info = await withTimeout(
          probe.getInfo(),
          PDF_PARSE_TIMEOUT_MS,
          'PDF 解析',
        );
        assertPdfPageCount(info.total);
      } finally {
        // 探测实例持有 pdf.js 的 worker 资源，用完必须销毁（失败也不能漏）
        await probe.destroy().catch(() => undefined);
      }

      const loader = new PDFLoader(absolute, { splitPages: true });
      const pages = await withTimeout(
        loader.load(),
        PDF_PARSE_TIMEOUT_MS,
        'PDF 解析',
      );
      // 空白页在 loader 里已被跳过；页与页之间留空行，保住段落边界
      const text = pages.map((page) => page.pageContent).join('\n\n');
      const normalized = normalizeText(text);
      // 长度闸口只在这里（PDF 扫描件检测），不要上移到 load() 影响其它格式
      if (normalized.length < MIN_TEXT_LENGTH) {
        throw new BadRequestException('PDF 未包含可提取文本，可能是扫描件');
      }
      return normalized;
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException(
        `PDF 解析失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * DOCX 提取：DocxLoader 内部用 mammoth 取纯文本；空文档它会返回空数组，这里归一化后判空。
   * 与 PDF 一样，任何异常都包成 400 固定前缀，便于前端展示与排查。
   * 沿用「已删除的旧 DocxParser」的语义：只拒绝空内容，不设 20 字符下限。
   */
  private async loadDocx(absolute: string): Promise<string> {
    try {
      const docs = await new DocxLoader(absolute).load();
      const normalized = normalizeText(
        docs.map((doc) => doc.pageContent).join('\n'),
      );
      if (!normalized) {
        throw new BadRequestException('DOCX 未包含可提取文本');
      }
      return normalized;
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException(
        `DOCX 解析失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
