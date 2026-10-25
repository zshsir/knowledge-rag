/**
 * PDF 解析的前置保护。
 * 边界：只负责「能不能解析」和「别把进程拖死」，文本提取交给 LangChain 的 PDFLoader。
 * 为什么单独拆出来：PDFLoader 自身没有页数上限与超时概念，直接用它会让超大 PDF
 *                在 1.8GB 内存的机器上把 worker 打爆。
 */
import { BadRequestException } from '@nestjs/common';

/** 页数上限：超过就拒绝，避免超大扫描件耗尽内存 */
export const MAX_PDF_PAGES = 200;

/** 单次 PDF 解析超时（读元数据与正文各算一次，不是整篇的总预算） */
export const PDF_PARSE_TIMEOUT_MS = 60_000;

/**
 * 页数校验：total 来自 pdf-parse 的 getInfo()，比整篇解析便宜得多。
 * 抛 BadRequestException 而不是普通 Error：调用方据此把文档标成永久失败，不消耗队列重试。
 */
export function assertPdfPageCount(total: number): void {
  if (total > MAX_PDF_PAGES) {
    throw new BadRequestException(`PDF 页数超过 ${MAX_PDF_PAGES} 页`);
  }
}

/**
 * 给任意 promise 加超时，超时后抛普通 Error（由上层统一包成 BadRequestException）。
 * label 只拼在错误文案前面（如「PDF 解析」→「PDF 解析超时」），与解析逻辑无关。
 * 关键语义：超时只约束调用方等待多久，不会取消底层任务——promise 没有取消接口，
 * PDFLoader 也不交出它内部的 PDFParse 实例（它自己的 finally 要等 getText/getInfo 落定才
 * destroy），所以超时后 pdf.js 仍会继续解析到结束并占着 buffer。
 * 这是 loader 路径相对「已删除的旧 PdfParser」（旧实现在 finally 里 parser.destroy()，
 * 能中断在途解析）的已知回归；B8 删旧实现时评估过：补回中断属于行为变更，另开任务。
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}超时`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
