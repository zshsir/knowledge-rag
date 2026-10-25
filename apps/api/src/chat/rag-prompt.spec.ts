/**
 * 提示链单测：只验「资料 + 历史 + 问题 → 模型消息」这一层纯函数。
 * 边界：不检索、不打模型，因此这里不需要任何假 provider；
 *      断言的重点是「引用编号格式」和「消息顺序/角色」——这两项前端和落库都在依赖。
 * 已知缺口（很窄）：toRole 的兜底分支 rag-prompt.ts:77「非 system/ai 一律按 user」其实每条
 *      buildRagMessages 用例都会走到——模板产出的 human 消息（当前问题、user 历史）正是在 :77
 *      落成 role:'user'，下面「消息顺序为 system → history → 当前问题」那条用例就直接断言了它。
 *      真正没被测到的是「第四种类型」：模板只给出 system/human/ai 三种，构造不出既非这三种的
 *      message.type，所以 :77 这层「未知类型也当 user」的防御从未因「未知」而触发（不改模板测不到）。
 */
import { buildRagMessages, formatNumberedContext } from './rag-prompt';
import { Source } from './sources';

const source: Source = {
  index: 1,
  documentId: 'd1',
  filename: '手册.md',
  chunkId: 'c1',
  chunkIndex: 3,
  score: 0.9,
  content: '发布代号是 Atlas',
};

describe('rag-prompt', () => {
  // 回归点：头行必须带「[编号] 文件：…（片段 n）」。编号来自检索阶段分配的 index，
  // 模型据此输出 [1]，前端再拿 index 去匹配引用卡片——三处任一改名或漏字段，标注就指不到原文
  it('上下文带引用编号与片段位置，供模型输出 [1] 标注', async () => {
    const context = formatNumberedContext([source]);
    expect(context).toContain('[1] 文件：手册.md（片段 3）');
    expect(context).toContain('发布代号是 Atlas');
  });

  /**
   * 逐字节钉住旧 PromptService 的输出格式（删除 prompt.service.ts 后，这里是唯一防线）：
   * 头行 + \n + 正文，资料之间用空行分隔；引用卡片与提示词里的编号必须一致。
   */
  it('多条资料的拼接格式与旧 PromptService 逐字节一致', async () => {
    const second: Source = {
      index: 2,
      documentId: 'd2',
      filename: '附录.pdf',
      chunkId: 'c2',
      chunkIndex: 0,
      score: 0.8,
      content: '附录内容',
    };
    expect(formatNumberedContext([source, second])).toBe(
      '[1] 文件：手册.md（片段 3）\n发布代号是 Atlas' +
        '\n\n' +
        '[2] 文件：附录.pdf（片段 0）\n附录内容',
    );
  });

  // 回归点：检索为空时不能拼出「参考资料：」+ 空串——那等于告诉模型「有资料但看不见」，
  // 会诱发编造。整串相等还挡住「在这个标记前面加编号」的改动（rag-prompt.ts:50 是无前缀的裸标记）
  it('无资料时给出明确的空上下文标记', async () => {
    expect(formatNumberedContext([])).toContain('没有检索到相关资料');
    // 整串相等：空标记不得带编号或前缀，否则会污染「资料」语义
    expect(formatNumberedContext([])).toBe('（没有检索到相关资料）');
  });

  // 回归点：system 在最前、当前问题在最后（provider 按数组顺序发请求）。
  // 最后一条用整对象相等，确保当前问题没有被追加到 system 里、也没被历史挤掉
  it('消息顺序为 system → history → 当前问题', async () => {
    const messages = await buildRagMessages(
      [{ role: 'user', content: '上一轮' }],
      [source],
      '发布代号是什么？',
    );
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('参考资料：');
    expect(messages[messages.length - 1]).toEqual({
      role: 'user',
      content: '发布代号是什么？',
    });
  });

  // 回归点：assistant 历史必须还原成 assistant 角色（rag-prompt.ts:64 映射成 AIMessage）。
  // 若退化成 user，模型会把上一轮自己的回答当成用户说的话，多轮问答直接错乱；
  // 同时资料只出现在 system 里，历史消息内容不许被污染
  it('system 消息带编号资料，历史保持原角色', async () => {
    const messages = await buildRagMessages(
      [
        { role: 'user', content: '上一轮问题' },
        { role: 'assistant', content: '上一轮回答' },
      ],
      [source],
      '发布代号是什么？',
    );
    expect(messages[0].content).toContain('[1] 文件：手册.md（片段 3）');
    expect(messages[1]).toEqual({ role: 'user', content: '上一轮问题' });
    expect(messages[2]).toEqual({ role: 'assistant', content: '上一轮回答' });
    expect(messages[3]).toEqual({ role: 'user', content: '发布代号是什么？' });
  });

  // 回归点：历史窗口是「最近 6 条」这个具体取值（rag-prompt.ts:24 的 HISTORY_LIMIT）。
  // 用 8 条构造，保证「取尾 6 条」与「取头 6 条」「取中间」这三种错法都能被区分出来；
  // 若哪天把上限调大调小，这条会红——那是有意的钉死，改动时要连同这里一起改
  it('历史只保留最近 6 条，丢弃更早的轮次', async () => {
    const history = Array.from({ length: 8 }, (_unused, index) => ({
      role: 'user' as const,
      content: `第 ${index + 1} 轮`,
    }));
    const messages = await buildRagMessages(history, [source], '当前问题');
    // 1 条 system + 6 条历史 + 1 条当前问题
    expect(messages).toHaveLength(8);
    expect(messages[1].content).toBe('第 3 轮');
    expect(messages[6].content).toBe('第 8 轮');
    expect(messages.some((message) => message.content === '第 1 轮')).toBe(false);
  });

  // 回归点：{context} 是在送进模板之前就用 JS 拼好的（rag-prompt.ts:30-31、:96），
  // 所以资料原文与用户问题里的花括号不会被 ChatPromptTemplate 当成变量解析。
  // 这条防的是「把用户内容直接塞进模板占位符」那种改法——轻则内容被吃掉，
  // 重则 formatMessages 抛 INVALID_PROMPT_INPUT，用户只是问个 JSON 写法就把这一轮问答打挂
  it('资料或问题里的花括号不会被当成模板变量二次解析', async () => {
    const tricky: Source = { ...source, content: '配置写法：{ "timeout": 30 }' };
    const messages = await buildRagMessages([], [tricky], '如何写 {timeout}？');
    expect(messages[0].content).toContain('{ "timeout": 30 }');
    expect(messages[1]).toEqual({ role: 'user', content: '如何写 {timeout}？' });
  });
});
