/**
 * pdfkit 的手写环境声明：只为让测试夹具能编译通过。
 * 为什么需要它：这个包没有随附类型、也没有 @types/pdfkit，而测试要用真 pdfkit 现场生成 PDF
 *      （不往仓库里塞二进制夹具）。没有这份文件，两处 `import PDFDocument from 'pdfkit'`
 *      会直接报 TS7016（隐式 any）。消费方只有两个：
 *      test/ingestion.e2e-spec.ts 的 makeBlankPdf（无文字层，触发「扫描件」判定）与
 *      src/ingestion/parsing/parsers.spec.ts 的 makePdf（可带一行文字）。
 * 覆盖范围：只声明这两处实际用到的 API，不是 pdfkit 的完整类型面——
 *      pdfkit 真正的 addPage / image / rect 等都没有，parsers.spec.ts 用到 addPage 时
 *      是在它自己文件里局部补的类型，没有回填到这里。
 *      其中 fontSize 与 PDFDocumentOptions 的 size/margin 三个成员目前是声明了但两处夹具都没用到
 *      （grep 这两个文件无命中），留着是为了形状像样，别当已验证路径。
 * 生效方式：tsconfig.json 的 include 覆盖 src 与 test 两棵目录下的全部 .ts，
 *      所以 src 侧的夹具与 test 侧的夹具都能看到本文件；
 *      它是纯类型，运行时不参与任何东西，也不会打进 dist。
 * 边界：不改 node_modules、不覆盖 pdfkit 的运行时行为，pdfkit 出错照样在运行时抛。
 */
declare module 'pdfkit' {
  /** 构造选项：两处夹具都是 `new PDFDocument()` 不传参，所以两个字段都可选 */
  interface PDFDocumentOptions {
    size?: string;
    margin?: number;
  }
  /**
   * 用法的真实形状（三件事：订阅流事件 → 写内容 → end 收尾）：
   * 1. on('data') 收 Buffer 分片，夹具把它们推进数组
   * 2. on('end') 表示 pdfkit 已把整份文档写完，夹具在这里 concat 出完整 PDF
   * 3. on('error') 把 pdfkit 的失败转成 Promise reject
   * 三个 on 重载返回 this 是为了能链式调用；end() 没有返回值，它只负责触发收尾。
   */
  class PDFDocument {
    constructor(options?: PDFDocumentOptions);
    on(event: 'data', listener: (chunk: Buffer) => void): this;
    on(event: 'end', listener: () => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
    fontSize(size: number): this;
    text(text: string): this;
    end(): void;
  }
  /** pdfkit 的入口就是这个类的默认导出（`import PDFDocument from 'pdfkit'`） */
  export default PDFDocument;
}
