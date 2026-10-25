/**
 * 入库流水线 e2e：验证「上传 → 解析 → 切分 → 嵌入 → 写库 → 可被检索」整条链路真的通到 pgvector。
 * 这里用假的 EMBEDDINGS_PROVIDER，绝不打真实模型服务：CI 不能依赖外部网络与额度，
 * 而且真向量的维度/相似度不可预测，断言就写不出来。
 * 假 provider 的接法与覆盖面（务必读这段再改）：
 * - 用 overrideProvider(EMBEDDINGS_PROVIDER) 换掉工厂产物，EmbeddingsService 与批次/条数/维度校验
 *   全是真的在跑（llm/embeddings.service.ts:87-116），只有最外层 HTTP 被替换
 * - 假向量固定 1024 维：与 chunks.embedding 的 vector(1024) 及 EMBEDDING_DIMENSIONS 默认值对齐
 *   （migrations/001_init.sql:104、config.service.ts 的 `get embedding()`），维度自检因此不会先炸
 * - 只提供 embedDocuments 一个方法：EmbeddingsService 只调这一个（:98），
 *   所以「provider 还有别的方法没被实现」不是问题，但反过来若哪天服务改调 embedQuery，
 *   这里会以 TypeError 形式暴露，不会静默通过
 * - 生成侧（CHAT_MODEL_PROVIDER）本文件完全不碰：入库不需要生成模型
 * 真实依赖清单（这些没有被替换）：Postgres（含 pgvector 与 HNSW 索引）、磁盘 UPLOAD_DIR
 * =./test/tmp-uploads（test/setup-env.ts:5）、ParserService/TextParser 的解码与切分、pg-boss 投递。
 * 关键结构：IngestionModule 被显式 import 进来（AppModule 不含它，API 进程本来只投递不消费），
 * 每条用例【直接 await ingestion.process(...)】而不是等队列——worker 进程在这套测试里不存在。
 * 共享状态与执行顺序（这是本文件最容易被无意破坏的地方）：
 * - fakeEmbeddings 这个 jest.fn 在整个 suite 共享，调用次数是【累计】的：
 *   所以每条断言都先记 callsBefore 再切片统计。删掉这个「差分」而直接比总次数，
 *   用例就会变成只能按文件里的书写顺序通过（实际顺序：文本 → GB18030 → 空白 PDF → 可重试故障，
 *   setup() 的后缀依次是 a、c、b、d，【不是】字母表顺序，别按字母重排它）
 * - 权限与数据侧没有顺序依赖：每条用例 setup() 都新建组织与库，整套不 truncate
 * - 第一条用例内部有硬顺序：embeddedCount 必须在 retrieve 之前算，
 *   因为检索的问题向量也走同一个 provider（详见该处注释）
 * PDF 夹具 makeBlankPdf 用 pdfkit 现场生成一份无文本层的真 PDF（不往仓库塞二进制），
 * 类型声明来自 test/fixtures/pdfkit.d.ts——pdfkit 不带 @types，那份手写声明是编译能过的唯一原因。
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import iconv from 'iconv-lite';
import PDFDocument from 'pdfkit';
import { AppModule } from '../src/app.module';
import { IngestionModule } from '../src/ingestion/ingestion.module';
import { DatabaseService } from '../src/database/database.service';
import { IngestionService } from '../src/ingestion/ingestion.service';
import { RetrievalService } from '../src/chat/retrieval.service';
import { EMBEDDINGS_PROVIDER } from '../src/llm/llm.tokens';

/** 固定内容的 1024 维向量：与 chunks.embedding 的 vector(1024) 对齐，全同一数值方便相似度算分 */
function fakeEmbedding() {
  return Array.from({ length: 1024 }, () => 0.01);
}

/** 一份合法但没有任何可提取文字的 PDF：走的是 parser.service.ts:142 那条「扫描件」判定 */
function makeBlankPdf(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

describe('ingestion', () => {
  let app: INestApplication;
  let db: DatabaseService;
  let ingestion: IngestionService;
  // 嵌入的唯一入口：IngestionService 与 RetrievalService 都经 EmbeddingsService 打到这个假 provider
  const fakeEmbeddings = {
    embedDocuments: jest.fn(async (texts: string[]) =>
      texts.map(() => fakeEmbedding()),
    ),
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [AppModule, IngestionModule],
    })
      .overrideProvider(EMBEDDINGS_PROVIDER)
      .useValue(fakeEmbeddings)
      .compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    db = app.get(DatabaseService);
    ingestion = app.get(IngestionService);
  });
  afterAll(() => app.close());

  /**
   * 一条用例一套独立租户（新用户 + 新组织 + 一个 org 模式的新库）。
   * 之所以每条都新建而不是共用：documents/chunks 上的断言全是按 documentId 精确查的，
   * 但 provider 的调用计数是全 suite 共享的，租户隔离帮不了后者，只能靠 callsBefore 差分
   */
  const setup = async (suffix: string) => {
    const agent = request.agent(app.getHttpServer());
    const register = await agent
      .post('/api/auth/register')
      .send({
        name: 'Owner',
        email: `ingest-${suffix}-${Date.now()}@test.local`,
        password: 'password123',
        orgName: `Ingest ${suffix}`,
      })
      .expect(201);
    const orgId = register.body.organizations[0].id as string;
    const kb = await agent
      .post(`/api/orgs/${orgId}/knowledge-bases`)
      .send({ name: 'Ingest KB', accessMode: 'org' })
      .expect(201);
    return {
      agent,
      orgId,
      kbId: kb.body.id as string,
      userId: register.body.user.id as string,
    };
  };

  // 回归点：整条流水线的「形状正确」——状态终值、片段数、向量维度、嵌入调用与片段的对应关系、
  // 检索能召回、分片接口读得到同一份正文。任何一环被换成「整篇一次嵌入」或「漏批」都会在这里红
  it('ingests text into chunks and marks the document ready', async () => {
    const { agent, orgId, kbId, userId } = await setup('a');
    // 夹具文本要「明显超过一个片段」：默认 CHUNK_SIZE=800 / CHUNK_OVERLAP=120，
    // 单位串约 21 字符，repeat(80) 约 1680 字符 -> 切出多个片段。
    // 只有片段数 >=2，下面「provider 收到的文本总数 == chunk_count」才有判别力：
    // 若有人把入库退回成「整篇文档拼一次去嵌入」，embeddedCount 会是 1 而 chunk_count 是多块，
    // 该断言立刻失败；夹具若只有 1 块则两种实现都给 1，断言形同虚设。
    const upload = await agent
      .post(`/api/orgs/${orgId}/knowledge-bases/${kbId}/documents`)
      .attach(
        'file',
        Buffer.from(
          '知识库问答系统用于企业内部资料检索与回答。'.repeat(80),
        ),
        { filename: 'handbook.txt', contentType: 'text/plain' },
      )
      .expect(201);

    // spy 在整个 suite 里共享，先记录调用进度，后面的计数只统计这一次入库
    const callsBefore = fakeEmbeddings.embedDocuments.mock.calls.length;

    await ingestion.process({
      documentId: upload.body.id,
      orgId,
      kbId,
      uploadedBy: userId,
    });

    const doc = await db.query<{ status: string; chunk_count: number; error: string | null }>(
      'SELECT status, chunk_count, error FROM documents WHERE id = $1',
      [upload.body.id],
    );
    expect(doc.rows[0].status).toBe('ready');
    expect(doc.rows[0].chunk_count).toBeGreaterThan(0);
    // 显式钉住「多块」下限：夹具一旦缩回 1 块，下面 embeddedCount==chunk_count 就会失去判别力，
    // 所以这里先保证 chunk_count >= 3，让那条计数断言始终能区分「按块嵌入」与「整篇嵌入」。
    expect(doc.rows[0].chunk_count).toBeGreaterThanOrEqual(3);
    expect(doc.rows[0].error).toBeNull();

    const chunks = await db.query<{ count: string; dims: number }>(
      `SELECT count(*)::text AS count, min(vector_dims(embedding)) AS dims
       FROM chunks WHERE document_id = $1`,
      [upload.body.id],
    );
    expect(Number(chunks.rows[0].count)).toBe(doc.rows[0].chunk_count);
    expect(chunks.rows[0].dims).toBe(1024);
    // 入库必须走新的 provider 入口（EmbeddingsService -> EMBEDDINGS_PROVIDER）
    expect(fakeEmbeddings.embedDocuments).toHaveBeenCalled();
    expect(fakeEmbeddings.embedDocuments.mock.calls.length).toBeGreaterThan(
      callsBefore,
    );
    // 这一次入库里 provider 收到的文本总数（各批相加）必须等于落库片段数：
    // 嵌入与片段一一对应、没有漏批，也证明维度校验之前那条链路真的通到了 provider。
    // 顺序是硬约束：必须在下面 retrieve 之前算好——检索的问题向量同样走这个 provider，
    // 放到 retrieve 之后就会多出一条 '知识库问答'，embeddedCount == chunk_count 立刻失真。
    const embeddedCount = fakeEmbeddings.embedDocuments.mock.calls
      .slice(callsBefore)
      .reduce((total, call) => total + call[0].length, 0);
    expect(embeddedCount).toBe(doc.rows[0].chunk_count);

    const callsBeforeRetrieve = fakeEmbeddings.embedDocuments.mock.calls.length;
    const sources = await app.get(RetrievalService).retrieve(
      orgId,
      kbId,
      '知识库问答',
    );
    // B6 之后检索侧的向量也挂在 EmbeddingsService -> EMBEDDINGS_PROVIDER 上，
    // 手写 fetch 的旧 LlmService 已在 B8 删除：若有人把检索又接回某个自建 HTTP 客户端，
    // 这里不会静默通过，而是真的向 LLM_BASE_URL 发一次 /embeddings 请求。
    expect(fakeEmbeddings.embedDocuments.mock.calls.length).toBe(
      callsBeforeRetrieve + 1,
    );
    expect(fakeEmbeddings.embedDocuments.mock.lastCall?.[0]).toEqual([
      '知识库问答',
    ]);
    // 这里的 index:1 是检索步骤 4「重排后从 1 开始编号」的产物（retrieval.service.ts:54），
    // 也就是回答里 [1] 那个引用序号；filename 来自 JOIN documents，
    // 两条合起来才证明 chunks 与 documents 的关联和 org/kb 双条件都写对了
    expect(sources.length).toBeGreaterThan(0);
    expect(sources[0]).toMatchObject({
      index: 1,
      filename: 'handbook.txt',
      documentId: upload.body.id,
    });
    expect(sources[0].content).toContain('知识库问答系统');

    const chunkResponse = await agent
      .get(`/api/orgs/${orgId}/documents/${upload.body.id}/chunks`)
      .expect(200);
    expect(chunkResponse.body).toHaveLength(doc.rows[0].chunk_count);
    expect(chunkResponse.body[0]).toMatchObject({
      chunkIndex: 0,
    });
    expect(chunkResponse.body[0].content).toContain('知识库问答系统');
  });

  // 回归点：这是「解析层」与「切分/嵌入层」的分界处唯一一次端到端验证——
  // 断言只查 documents 的终态与 chunks 计数，不查内容，正文由紧随其后的分片接口核对。
  // 名字说 "without mojibake"，实际证明方式是「落库正文里能原样找到那句中文」，
  // 也就是解码错与没错都只体现在那一句 contains 上（没有逐字节比全文）
  it('ingests a GB18030 encoded TXT without mojibake', async () => {
    // 规格 §6.4：老中文文档常用 GB18030 编码。这里端到端守住「UTF-8 严格解码失败后回退 GB18030」
    // 的历史修复，防止将来有人把 TXT 也换成只按 UTF-8 读的 TextLoader。
    const { agent, orgId, kbId, userId } = await setup('c');
    const original =
      '知识库问答系统支持中文编码文档的解析与检索。'.repeat(5);
    const upload = await agent
      .post(`/api/orgs/${orgId}/knowledge-bases/${kbId}/documents`)
      .attach('file', iconv.encode(original, 'gb18030'), {
        filename: 'legacy-gb18030.txt',
        contentType: 'text/plain',
      })
      .expect(201);

    await ingestion.process({
      documentId: upload.body.id,
      orgId,
      kbId,
      uploadedBy: userId,
    });

    const doc = await db.query<{ status: string; chunk_count: number }>(
      'SELECT status, chunk_count FROM documents WHERE id = $1',
      [upload.body.id],
    );
    expect(doc.rows[0].status).toBe('ready');
    expect(doc.rows[0].chunk_count).toBeGreaterThan(0);

    // 走现有片段接口核对落库正文：乱码时这里不会是原始中文
    const chunkResponse = await agent
      .get(`/api/orgs/${orgId}/documents/${upload.body.id}/chunks`)
      .expect(200);
    expect(chunkResponse.body.length).toBeGreaterThan(0);
    expect(chunkResponse.body[0].content).toContain('知识库问答系统支持中文编码文档');
  });

  // 回归点：/未包含可提取文本/ 这条入库契约本身（文案出自 parser.service.ts:143 的 PDF 分支）。
  // 换成 LangChain PDFLoader 后最容易丢的就是这条，所以断言按正则钉住文案而不是只判 status。
  // 顺带钉住「内容类错误不上抛」：本用例直接 await process() 却没有 rejects 断言，
  // 它若能正常 resolve 本身就是 ingestion.service.ts:141 那个 BadRequestException 分支的证据
  //（否则 await 会先把这条用例打成失败）。可重试分支的对照在第四条用例
  it('marks a PDF without extractable text as failed', async () => {
    const { agent, orgId, kbId, userId } = await setup('b');
    const blank = await makeBlankPdf();
    const upload = await agent
      .post(`/api/orgs/${orgId}/knowledge-bases/${kbId}/documents`)
      .attach('file', blank, {
        filename: 'scan.pdf',
        contentType: 'application/pdf',
      })
      .expect(201);

    await ingestion.process({
      documentId: upload.body.id,
      orgId,
      kbId,
      uploadedBy: userId,
    });

    const doc = await db.query<{ status: string; error: string | null }>(
      'SELECT status, error FROM documents WHERE id = $1',
      [upload.body.id],
    );
    expect(doc.rows[0].status).toBe('failed');
    expect(doc.rows[0].error).toMatch(/未包含可提取文本/);
  });

  // 回归点：与上一条正相反的那条出口——非 400 的 provider 故障要「落库 failed + 原样上抛」，
  // 上抛是 pg-boss 判断重试的依据。名字里的 "propagates" 靠 rejects.toThrow 钉，
  // "marks failed" 靠后面那次 SELECT 钉，两半都有断言
  it('propagates a retryable provider error and marks the document failed', async () => {
    // 守护入库 catch 分支的「可重试失败」这一条出口（与扫描件那条「内容问题只落库不上抛」正相反）：
    // 非 BadRequestException 的 provider 故障必须 1) 把 documents.status 落成 failed（否则前端卡在解析中），
    // 2) 把原始错误一路上抛给调用方（pg-boss 靠这个异常决定是否重试）。
    // 用 mockRejectedValueOnce 只让下一次 provider 调用抛普通 Error，测完自动恢复，不动整份 suite。
    const { agent, orgId, kbId, userId } = await setup('d');
    const upload = await agent
      .post(`/api/orgs/${orgId}/knowledge-bases/${kbId}/documents`)
      .attach(
        'file',
        Buffer.from('知识库问答系统用于企业内部资料检索与回答。'.repeat(5)),
        { filename: 'flaky.txt', contentType: 'text/plain' },
      )
      .expect(201);

    fakeEmbeddings.embedDocuments.mockRejectedValueOnce(
      new Error('provider 暂时不可用'),
    );

    await expect(
      ingestion.process({
        documentId: upload.body.id,
        orgId,
        kbId,
        uploadedBy: userId,
      }),
    ).rejects.toThrow('provider 暂时不可用');

    const doc = await db.query<{ status: string; error: string | null }>(
      'SELECT status, error FROM documents WHERE id = $1',
      [upload.body.id],
    );
    expect(doc.rows[0].status).toBe('failed');
    expect(doc.rows[0].error).toContain('provider 暂时不可用');
  });
});
