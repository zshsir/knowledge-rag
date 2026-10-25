/**
 * 文本切分：把整篇文档切成尽量互相重叠的片段，供嵌入与检索使用。
 * 边界：只做切分，不做解码（parser 层）、不做嵌入（llm 层）。
 * 调用方：ingestion.service 的入库流程。
 */
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { normalizeText } from './normalize';

/**
 * 中文优先的分隔符序列。
 * 原因：LangChain 默认分隔符按空格/句子切，中文几乎没有空格，
 *      不显式配置会把整段塞进一块甚至超过 chunkSize。
 * 顺序即优先级：段落 > 换行 > 句末标点 > 逗号类 > 空格 > 逐字符兜底。
 */
const SEPARATORS = ['\n\n', '\n', '。', '！', '？', '；', '，', '、', ' ', ''];

/**
 * 切分文档。
 * 步骤：
 * 1. 先归一化（统一换行、压缩空行），保证切分基线一致
 * 2. 交给 RecursiveCharacterTextSplitter：按分隔符优先级递归切，块长 ≤ size；
 *    相邻块的重叠是「尽力而为」——合并时只把长度合计不超过 overlap 的尾部片段带到下一块，
 *    片段本身超过 overlap 时直接被丢弃，所以实际重叠可能为 0
 *    （实测：100/20 为 0，默认 800/120 约 108，具体取决于句子长度）
 * 3. 长度函数用 JS 字符串长度（UTF-16 码元，不是 token 数），与配置的 800/120 语义一致；
 *    注意 emoji 等增补平面字符算 2，递归退化到 '' 兜底时可能从代理对中间切开（中文正文无此问题）
 * 4. 过滤空白块，返回纯字符串数组给嵌入层
 * 重叠上限夹到 size - 1：不夹的话构造器直接抛 `Cannot have chunkOverlap >= chunkSize`
 *（@langchain/textsplitters@1.0.2）。这只保证参数合法，不代表步进合理：overlap = size - 1
 * 时每块只前进 1 个字符、块数暴涨，默认 800/120 不受影响，应在配置层另加约束。
 */
export async function splitToChunks(
  input: string,
  size = 800,
  overlap = 120,
): Promise<string[]> {
  // 步骤 1：归一化，空文本直接返回
  const text = normalizeText(input);
  if (!text) return [];

  // 步骤 2/3：中文分隔符 + 字符长度度量
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: Math.max(1, size),
    chunkOverlap: Math.max(0, Math.min(overlap, size - 1)),
    separators: SEPARATORS,
    lengthFunction: (value: string) => value.length,
  });

  // 步骤 4：过滤纯空白块
  const docs = await splitter.splitText(text);
  return docs.map((doc) => doc.trim()).filter(Boolean);
}
