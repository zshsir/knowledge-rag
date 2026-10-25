/**
 * splitToChunks 单测：守「中文优先切分」这条迁移契约——
 * LangChain RecursiveCharacterTextSplitter 的默认分隔符按空格/句子切，而中文几乎没有空格，
 * 不显式配置中文标点会整段塞成一块甚至超过 chunkSize（取舍见 chunker.ts:10-15）。
 * 它守的是单测层能覆盖的三件事：内容不丢、块不超长、相邻块之间有真实重叠。
 * 边界：纯函数测试，不测配置来源（CHUNK_SIZE/CHUNK_OVERLAP 的启动校验在 config.service.spec.ts）、
 *      不测嵌入与写库；切分器本身用真实的 @langchain/textsplitters，不打模型、不连库。
 * 历史：B4 评审发现这批用例对已删除的旧 chunkText 也一样全绿（等于没约束迁移），
 *      加固后才有判别力——实测把「。」移出分隔符序列、或把 overlap 设成 0，都会有用例变红。
 */
import { splitToChunks } from './chunker';

// 单句中文样本：长度刚好能被 100 的 chunkSize 切成多块，用来验「块不超长」这类只看长度的断言
const zh = '知识库问答系统用于企业内部资料检索与回答，支持多种文档格式和团队协作。';

// 60 条互不相同的句子（约 1.6k 字符）。
// 用不同的句子而不是 zh.repeat(10) 这类周期文本：周期文本里任意子串都能在别处找到，
// 任何 includes 断言都会假阳性，无法区分「真重叠」与「没重叠」。
const DISTINCT_SENTENCES = Array.from(
  { length: 60 },
  (_, i) => `第${i}条记录描述了编号${i * 7 + 3}的客户合同条款与付款进度。`,
);
const DISTINCT_TEXT = DISTINCT_SENTENCES.join('');

/**
 * 两块之间真正的重叠长度：最大的 k，使后一块的前 k 个字符正好是前一块的最后 k 个字符。
 * 不用 includes（周期文本会假阳性），也不用 endsWith(next.slice(0, 40))：
 * 实际重叠（默认配置实测 108）大于 40 时前后对位不同，那种写法会假阴性。
 */
function overlapSize(prev: string, next: string): number {
  for (let k = Math.min(prev.length, next.length); k > 0; k -= 1) {
    if (prev.endsWith(next.slice(0, k))) return k;
  }
  return 0;
}

describe('splitToChunks', () => {
  // 回归点：归一化后为空的输入必须返回空数组（chunker.ts:39 的短路），而不是产生一个空块
  // 写进库——空块一路到嵌入层才会显形，且会占住一个 chunk 位置。
  // 注意输入是「纯空白」而非真正的空串：空串走的是同一条短路，但本文件没有单独覆盖
  it('空文本返回空数组', async () => {
    expect(await splitToChunks(' \n\n ')).toEqual([]);
  });

  // 回归点：块长必须 ≤ 传入的 size——用户在配置里写的 CHUNK_SIZE 只有切分器这一处能被产出侧
  // 验证（配置层校验的见 config.service.spec.ts，只管取值是否合法）。size 被忽略或 clamp 写错，这里先红。
  // 这里只断言长度不断言内容：zh 是周期文本，内容断言会假阳性，内容检查交给下面几条
  it('每块不超过配置长度', async () => {
    const chunks = await splitToChunks(zh.repeat(10), 100, 20);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 100)).toBe(true);
  });

  it('相邻块真实重叠：默认 800/120 下后一块开头与前一地块结尾重合 40 字符以上', async () => {
    const chunks = await splitToChunks(DISTINCT_TEXT); // 默认 800 / 120
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 1; i < chunks.length; i += 1) {
      // 先断言非空，避免空块让重叠断言退化成无意义的 0
      expect(chunks[i].length).toBeGreaterThan(1);
      expect(overlapSize(chunks[i - 1], chunks[i])).toBeGreaterThanOrEqual(40);
    }
  });

  it('中文标点参与切分：块边界落在「。」处，而不是按 60 字符硬切', async () => {
    // 句子内部含「，」「；」：若「。」被移出分隔符序列，边界会退到「；」「，」
    // 或按 60 字符硬切，后续块的首字符就不再是「。」。
    const text = '项目甲，包含多项条款；编号乙。'.repeat(9);
    const chunks = await splitToChunks(text, 60, 0);
    expect(chunks.length).toBeGreaterThan(1);
    // 分隔符被保留在后一块开头，因此「除首块外都以『。』开头」等价于「边界落在句末标点处」
    expect(chunks.slice(1).every((chunk) => chunk.startsWith('。'))).toBe(true);
    // 无空白文本、重叠为 0：切分不增不减，拼回去必须等于原文
    expect(chunks.join('')).toBe(text);
  });

  it('不丢内容：重叠为 0 时各块拼接后等于原文', async () => {
    const original = zh.repeat(5); // 无空白字符，trim 不会改变内容
    const chunks = await splitToChunks(original, 100, 0);
    // 显式断言非空：空数组上 every/includes 恒真，会把「全部丢块」判为通过
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.join('')).toBe(original);
  });

  // 回归点：归一化发生在切分之前、且结果原样留在块里（chunker.ts:38 → normalize.ts:2-6）。
  // 迁移时这条最容易被漏：LangChain 的切分器不做归一化，若去掉那次调用，
  // \r 会被写进 chunks 表，前端展示与检索命中片段都会带着 Windows 换行
  it('归一化：CRLF 统一为 LF，并压缩连续空行', async () => {
    expect(await splitToChunks('a\r\nb\r\n\r\n\r\nc')).toEqual(['a\nb\n\nc']);
  });
});
