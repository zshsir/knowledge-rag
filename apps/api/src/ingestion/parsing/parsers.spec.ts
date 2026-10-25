/**
 * ParserService.load 单测：守「格式分派 + 各格式的空内容/超限契约」这层迁移中最容易丢的行为。
 * 具体契约（四条都对应真实事故或评审发现）：
 * - TXT/MD 保留自研解码：UTF-8 严格解码失败后回退 GB18030，中文文档不许乱码
 *   （换成 LangChain TextLoader 就只能读 UTF-8，这是迁移时特意不采用的原因）
 * - 20 字符下限只作用于 PDF：B3 评审曾发现把它统一成全局闸口会让 10 字的 TXT 备忘录
 *   从 ready 变 failed，本文件的「短 TXT」与「空白 PDF」两条用例分别圈住这个闸口的两侧
 * - 空白 PDF 报「PDF 未包含可提取文本，可能是扫描件」、坏 PDF 报「PDF 解析失败：…」——这两条把断言
 *   写到字面，理由是整条 message 被 ingestion.service.ts:41 截到 500 字符后原样写进 documents.error，
 *   前端只是整串显示它（DocumentsPage.tsx:323 直接渲染 doc.error），没有任何按前缀分类的消费方；
 *   钉字面是因为改文案=改用户看到的失败原因。未知扩展名那条【不同】：只断言异常类型
 *   （BadRequestException=400），并没有钉它的文案「不支持的文档格式」（见该用例自己的说明）
 * - 两个「空内容」闸口各自收口：DOCX 报「DOCX 未包含可提取文本」、TXT/MD 报「文档内容为空」。
 *   这两条是设计文档 §2.3 列的必须保留契约，此前只有抛出点、零用例（final review Minor #10），
 *   断言同样写到字面，理由与上一条相同
 * 边界：不切分（chunker.spec.ts）、不嵌入、不写库、不起 Nest；用真实的 pdfkit/docx 生成最小文件，
 *      因为 loader 只吃磁盘上的真路径，无法用纯 mock 替代。绝不打模型服务与网络。
 */
import { BadRequestException } from '@nestjs/common';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import PDFDocument from 'pdfkit';
import { Document as DocxDocument, Packer, Paragraph } from 'docx';
import iconv from 'iconv-lite';
import { ParserService } from './parser.service';
import { TextParser } from './text.parser';
import { StorageService } from '../../storage/storage.service';

const tempDirs: string[] = [];

/**
 * 造一个最小的 PDF。不传 text 时只有一页空白，用来模拟扫描件。
 * pageCount 用于生成超过页数上限的大文件。
 */
function makePdf(text?: string, pageCount = 1): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    if (text) doc.text(text);
    // 本仓的 pdfkit 环境声明（test/fixtures/pdfkit.d.ts）没写 addPage，这里局部补类型再调用
    const pageable = doc as unknown as { addPage: () => void };
    for (let i = 1; i < pageCount; i += 1) pageable.addPage();
    doc.end();
  });
}

/** 用 docx 库造一个单段落文档，避免仓库里放二进制 fixture */
async function makeDocx(text: string): Promise<Buffer> {
  const doc = new DocxDocument({
    sections: [{ children: [new Paragraph(text)] }],
  });
  return Packer.toBuffer(doc);
}

/**
 * 用临时目录冒充 StorageService。
 * LangChain 的 loader 只接受真实文件路径（它自己 readFile），
 * 所以 absolutePath 必须返回磁盘上真实存在的文件，不能返回空串。
 * 两个假方法都忽略入参：absolutePath 恒返回那份唯一文件、readFile 恒返回同一 buffer。
 * 代价是本文件测不出「load 把 storageKey 传错给 absolutePath」这类缺陷；
 * 传进 load 的 orgs/... 长键只起两个作用——决定扩展名分派分支、成为 metadata.source 的期望值。
 */
function buildService(buffer: Buffer, extension: string) {
  const dir = mkdtempSync(join(tmpdir(), 'parser-spec-'));
  tempDirs.push(dir);
  const file = join(dir, `sample${extension}`);
  writeFileSync(file, buffer);
  const storage = {
    absolutePath: () => file,
    readFile: async () => buffer,
  } as unknown as StorageService;
  return new ParserService(storage, new TextParser());
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('ParserService.load', () => {
  // 回归点：迁移到 LangChain 后 TXT 若改走 TextLoader（只按 UTF-8 读），这份 GB18030 字节
  // 会变成乱码或解码异常；顺带钉住 metadata.source 就是传入的 storageKey——引用展示要靠它
  it('TXT 走 GB18030 回退，中文不乱码', async () => {
    const content = '知识库问答系统是一个支持中文文档检索与问答的平台';
    const service = buildService(iconv.encode(content, 'gb18030'), '.txt');
    const docs = await service.load(
      'orgs/a/knowledge-bases/b/documents/c/d.txt',
    );
    expect(docs[0].pageContent).toContain(content);
    expect(docs[0].metadata.source).toBe(
      'orgs/a/knowledge-bases/b/documents/c/d.txt',
    );
  });

  // 回归点：B3 评审发现的真实回归——把 MIN_TEXT_LENGTH 从 PDF 分支上移到 load() 后，
  // 这条 10 字 TXT 会 400 → 文档永久 failed（不重试），与迁移前行为不一致。
  // 注意覆盖面：这一条只钉 TXT 的「不套 20 字符下限」；DOCX 侧的闸口是「只拒绝空内容」，
  // 由下面那条「空 DOCX 报 DOCX 未包含可提取文本」钉住（两者共用 MIN_TEXT_LENGTH 只作用于 PDF 这条规则）
  it('短 TXT（10 个汉字）正常入库，不套用 PDF 的 20 字符下限', async () => {
    // 旧契约：TXT/MD 只在空内容时失败。长度闸口收窄到 PDF 后，这条必须仍然通过，
    // 否则 10 字的备忘录会被当成永久失败（400 → failed，不重试）。
    const content = '十个汉字的短文本测试';
    expect(content).toHaveLength(10);
    const service = buildService(Buffer.from(content, 'utf8'), '.txt');
    const docs = await service.load(
      'orgs/a/knowledge-bases/b/documents/c/short.txt',
    );
    expect(docs).toHaveLength(1);
    expect(docs[0].pageContent).toBe(content);
  });

  // 回归点：PDFLoader（splitPages:true + join('\n\n')）确实能取到正文，并且整份合并成
  // 单个 Document 返回；若哪天改成按页返回多个 Document，这条长度断言会先红
  it('PDF 正文可提取，并按单文档返回', async () => {
    const service = buildService(
      await makePdf('Knowledge base PDF content with enough text.'),
      '.pdf',
    );
    const docs = await service.load(
      'orgs/a/knowledge-bases/b/documents/c/report.pdf',
    );
    expect(docs).toHaveLength(1);
    expect(docs[0].pageContent).toContain('Knowledge base PDF content');
  });

  // 回归点：扫描件契约。这条最容易被「loader 报错」的实现悄悄替代，所以断言写死整句文案，
  // 保证走的是「解析成功但正文短于 20 字符」的判定，而不是被包成「PDF 解析失败：…」
  it('空白 PDF 报「PDF 未包含可提取文本」', async () => {
    const service = buildService(await makePdf(), '.pdf');
    const error = await service
      .load('orgs/a/knowledge-bases/b/documents/c/scan.pdf')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BadRequestException);
    // 精确到这条文案：证明是「解析成功但没文本」的扫描件判定，而不是 loader 抛错被包成「PDF 解析失败」
    expect((error as Error).message).toBe(
      'PDF 未包含可提取文本，可能是扫描件',
    );
  });

  // 回归点：页数上限必须在昂贵的整篇解析之前生效（服务器只有 1.8GB 内存）。
  // 正则里的 200 是写死的，而实现把 MAX_PDF_PAGES 插值进文案（pdf-pages.ts:21），
  // 所以这条同时把上限的具体取值钉进了测试；它没有断言 PDFLoader 未被调用，
  // 「探测确实更便宜」只能由实现顺序保证，本用例只能证明最终抛出了超限错误
  it('PDF 超过 200 页直接拒绝', async () => {
    const service = buildService(await makePdf(undefined, 201), '.pdf');
    await expect(
      service.load('orgs/a/knowledge-bases/b/documents/c/huge.pdf'),
    ).rejects.toThrow(/页数超过 200 页/);
  });

  // 回归点：非业务异常统一包成固定前缀，好让队列按「永久失败」处理而不是无限重试。
  // 只匹配前缀：后半截是 pdf.js 自己的消息，随依赖版本变，钉死会变成无意义的脆弱断言
  it('无法解析的 PDF 包成「PDF 解析失败：…」', async () => {
    const service = buildService(Buffer.from('not a pdf'), '.pdf');
    const error = await service
      .load('orgs/a/knowledge-bases/b/documents/c/broken.pdf')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as Error).message).toMatch(/^PDF 解析失败：/);
  });

  // 回归点：本条保证 DocxLoader（底层 mammoth）仍能取到正文——
  // 它是下面那条「空 DOCX」用例的前提（连正常内容都取不到时，判空那条会假通过）
  it('DOCX 正文可提取', async () => {
    const service = buildService(
      await makeDocx('Knowledge base DOCX content'),
      '.docx',
    );
    const docs = await service.load(
      'orgs/a/knowledge-bases/b/documents/c/memo.docx',
    );
    expect(docs[0].pageContent).toContain('Knowledge base DOCX content');
  });

  /**
   * 回归点（计划列为必须保留的行为契约，此前零覆盖）：DocxLoader 对空文档是【静默返回空数组】
   * 而不是报错，所以「没有文本」这件事只能由 loadDocx 的判空来定性。
   * 摘掉 parser.service.ts:165-167 那句判空，这份文档会带着空正文继续走切分与嵌入，
   * 最终停在 ready 且 0 片段——而不是现在这条永久失败的 400。
   * 断言写死整句文案的理由与空白 PDF 那条相同：整串 message 会被截到 500 字符原样落进
   * documents.error 并由前端直接渲染，改文案=改用户看到的失败原因。
   */
  it('空 DOCX 报「DOCX 未包含可提取文本」', async () => {
    const service = buildService(await makeDocx(''), '.docx');
    const error = await service
      .load('orgs/a/knowledge-bases/b/documents/c/empty.docx')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BadRequestException);
    // 精确到文案：证明走的是「loader 成功但没提取到文本」这条判空，而不是包成「DOCX 解析失败：…」
    expect((error as Error).message).toBe('DOCX 未包含可提取文本');
  });

  /**
   * 回归点（同样是计划列的契约、此前只有抛出点没有用例）：TXT/MD 的空内容闸口。
   * 三种「有字节没内容」都得收在 400：空 buffer、纯空白、只有换行与制表符——
   * 它们都被 normalizeText 清成空串（text.parser.ts:64-68）。
   * 摘掉这句判空，这份文档会切出 0 个片段并停在 ready，
   * 而 ingestion.service 把「永久失败」与「可重试」的分界就押在 400 上。
   * 文案同样钉字面：它会原样出现在前端 DocumentsPage 的错误列里。
   */
  it.each([
    ['空 buffer', Buffer.from('')],
    ['只有空格', Buffer.from('   ')],
    ['只有换行与制表符', Buffer.from('\n\t\r\n  ')],
  ])('空 TXT（%s）报「文档内容为空」', (_name, buffer) => {
    let caught: unknown;
    try {
      new TextParser().parseBuffer(buffer);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    expect((caught as Error).message).toBe('文档内容为空');
  });

  // 回归点：load() 自己是第二道防线——上传校验（document-validation）之外的入口
  // （如 worker 直接按库里的键解析）也必须拒绝未知格式；断言只查类型不查文案
  it('未知扩展名返回 400', async () => {
    const service = buildService(Buffer.from('whatever'), '.bin');
    await expect(
      service.load('orgs/a/knowledge-bases/b/documents/c/raw.bin'),
    ).rejects.toThrow(BadRequestException);
  });
});
