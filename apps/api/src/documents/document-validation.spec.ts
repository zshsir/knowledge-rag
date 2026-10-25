/**
 * normalizeUploadFilename 单测：守「上传文件名乱码修复」这条契约——这是修过的线上事故
 * （浏览器按 UTF-8 发文件名、busboy 可能按 latin1 逐字节解码，中文文件名整体变乱码），
 * 完整背景与四步判据写在 document-validation.ts 的函数注释里，这里是它的回归网。
 * 边界：只测文件名修复这一个纯函数。validateUpload 的扩展名白名单与 magic bytes 由
 *      documents 的 e2e 覆盖（apps/api/test/documents.e2e-spec.ts 里的
 *      'rejects unsupported files and invalid magic bytes' 用例），体积闸口
 *      （MAX_UPLOAD_MB 与 multer 写死的 25MB）则没有任何测试；本文件不连库、不起 Nest、不碰 multer。
 * 刻意不覆盖：步骤 1 的空串短路，以及「确实是乱码但重新解码也得到 U+FFFD、于是保守留着乱码」
 *      这一支——后者要构造特定的字节序列，目前只由实现注释说明，没有用例钉住。
 */
import { normalizeUploadFilename } from './document-validation';

describe('normalizeUploadFilename', () => {
  // 回归点：事故现场本身——把 UTF-8 字节按 latin1 解出的乱码必须被还原成原名，
  // 且括号、全角符号与 .docx 后缀一个字符都不能变（否则入库/展示两处都会跟着错）
  it('repairs UTF-8 filenames decoded as latin1', () => {
    const original = '设计类专业设计报告书参考范本（本科段）.docx';
    // 手工复现 busboy 的误解码：先按 utf8 编成字节，再按 latin1 解释成字符
    const mojibake = Buffer.from(original, 'utf8').toString('latin1');
    expect(normalizeUploadFilename(mojibake)).toBe(original);
  });

  // 回归点：修复逻辑「别把本来对的名字改坏」——这一条比上一条更脆，误改是静默的
  it('keeps correct Chinese and accented filenames intact', () => {
    // 含码点 > 0xFF 的真汉字：在步骤 2 就收手，压根不进二次解码
    expect(normalizeUploadFilename('设计报告.docx')).toBe('设计报告.docx');
    // é 是 U+00E9，过得了步骤 2，靠步骤 4（解码结果含 U+FFFD 则回退原值）才没被改坏
    expect(normalizeUploadFilename('café.pdf')).toBe('café.pdf');
    // 用例名只提「中文与带音标」，这条纯 ASCII 直通没体现在名字里：它走的是步骤 3
    // 重新解码后恰好同值（不触发步骤 2 也不触发步骤 4 回退）
    expect(normalizeUploadFilename('notes.txt')).toBe('notes.txt');
  });
});
