/**
 * PDF 前置保护的两个纯函数单测：页数闸口 assertPdfPageCount 与超时壳 withTimeout。
 * 为什么存在：PDFLoader 本身既没有页数上限也没有超时概念，直接用会让超大/卡死的 PDF
 *      在 1.8GB 内存的 worker 上把进程拖死（见 pdf-pages.ts 文件头）。
 * 边界：只测这两个函数的判据与文案，不碰 pdf.js、不读真文件；真实 PDF 上的「先探测后解析」顺序
 *      没有任何用例断言过（parsers.spec.ts 的「超过 200 页」用例自己就写明「没有断言 PDFLoader 未被调用」），
 *      只是被 parsers.spec.ts 与 ingestion e2e 经过——跑到了那条路径不等于验证了先后；异常包前缀
 *      （「PDF 解析失败：…」）也只到 parsers.spec.ts 那条坏字节用例为止——没有任何用例真的让 ParserService 超时过一次。
 * 无法在这里表达的一条：withTimeout 只约束等待、不会取消底层解析（pdf.js 会继续跑完并持有
 *      buffer），这是相对已删除旧 PdfParser 的已知回归，只能靠注释记录，本文件没有断言能钉它。
 */
import { BadRequestException } from '@nestjs/common';
import { assertPdfPageCount, withTimeout } from './pdf-pages';

describe('assertPdfPageCount', () => {
  // 回归点：超限必须是 BadRequestException（400）而不是普通 Error —— 调用方按这个类型
  // 把文档判成「永久失败」，不消耗队列重试；抛错类型的选择就是行为契约的一部分
  it('超过 200 页直接拒绝（服务器内存只有 1.8GB）', () => {
    expect(() => assertPdfPageCount(201)).toThrow(BadRequestException);
    expect(() => assertPdfPageCount(201)).toThrow(/页数超过 200 页/);
  });

  // 回归点：边界取值 200 要放行（实现用的是 total > MAX，见 pdf-pages.ts:20），
  // 哪天改成 >= 就会把恰好 200 页的正常文档误杀
  it('200 页以内放行', () => {
    expect(() => assertPdfPageCount(200)).not.toThrow();
  });
});

describe('withTimeout', () => {
  // 回归点：promise 卡住时，超时到点必须以「label + 超时」的普通 Error 失败（pdf-pages.ts:40），
  // 否则入库任务会一直挂着。注意这里传的是 10ms，不是生产用的 PDF_PARSE_TIMEOUT_MS(60s)，
  // 所以本用例钉的是「超时壳本身会响」，不钉生产时限取值，也不经过 ParserService
  it('超时抛出带标签的错误，由 ParserService 统一包成 400', async () => {
    // 这就是最终对外文案：包进 ParserService 的前缀后是「PDF 解析失败：PDF 解析超时」
    // （措辞沿用已删除的旧 PdfParser，前端与排查脚本按这个前缀认）
    await expect(
      withTimeout(new Promise(() => undefined), 10, 'PDF 解析'),
    ).rejects.toThrow('PDF 解析超时');
  });
});
