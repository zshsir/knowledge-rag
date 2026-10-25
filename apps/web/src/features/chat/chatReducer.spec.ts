/**
 * chatReducer 的回归测试：钉住「一条流式回答的状态机」里三条不能坏的规则。
 * 这个 reducer 是前端 WebSocket 协议唯一的状态收敛点（chat:meta/delta/done/error 四类事件都进它），
 * 它退化时不会报错，只会表现为「气泡一直转圈」「上一轮的引用卡片串进这一轮」「停止后半条答案没了」。
 * 三条被测契约与出处（apps/web/src/features/chat/chatReducer.ts）：
 * 1. delta 按到达顺序累加（:88-89），done 只改状态、不清正文（:93-99）——「不清正文」正是取消时保住半条答案的机制
 * 2. requestId 闸门：与当前请求 id 不一致的事件原样返回旧状态（:77），
 *    挡的是「停止之后旧请求的尾包」和「快速连发时前一条的迟到事件」
 * 3. error 记下文案供气泡展示（:102），不把状态留在 streaming
 * 夹具说明：这里不需要真 socket 也不需要后端——整个 reducer 是纯函数，直接喂 action 序列即可。
 * 「事件真的按这个形状到达」由后端 realtime.e2e-spec.ts 负责，本文件测不到协议本身，
 * 两边的形状若漂开（比如服务端不再发 conversationId），这里不会红。
 * 环境说明：vitest 配的 environment 是 'node'（apps/web/vitest.config.ts），没有 jsdom，
 * 所以做不了组件渲染测试，ChatPage 里的派发时序（谁先发 reset）也不在本文件覆盖面内。
 * 未覆盖（动这几条分支时没有东西会拦）：
 * - 'reset' 这个 action 一条用例都没有，而 ChatPage 收尾与切会话全靠它
 * - done 的 cancelled:true 分支没测：也就是上面第 1 条里「取消后正文保留」这个最关键的语义
 *   只写在注释里，没有断言
 * - 闸门只测了 delta：meta / done / error 带别的 requestId 时是否也被丢，没有用例
 *   （代码是同一句 return state，但没被断言过）
 * - 三处断言都只挑感兴趣的字段比，没有整对象比较；具体缺口写在每条用例前面
 */
import { describe, expect, it } from 'vitest';
import { chatReducer, initialChatState } from './chatReducer';
import type { Source } from '../../lib/types';

/**
 * 一份最小可用的引用片段：index 是展示出来的引用序号、chunkId 是引用列表的 React key、
 * filename 是卡片标题，其余字段只为满足 Source 类型 —— reducer 自己不读它们，
 * 所以这里的值（'d1'/'c1'）没有业务含义，别把它们当成与后端约定过的 id
 */
const source: Source = {
  index: 1,
  documentId: 'd1',
  filename: 'a.md',
  chunkId: 'c1',
  chunkIndex: 0,
  score: 0.9,
  content: '资料',
};

describe('chatReducer', () => {
  // 回归点：一轮正常问答的终态。两段 delta 必须按到达顺序拼（反了就是 '好你'），
  // meta 的引用整组替换进来，done 把状态推到 done 且 cancelled=false。
  // 「done 不清正文」这条就落在最后一句 assistantText 仍是 '你好' 上——done 刻意不清正文，
  // 取消场景才能靠同一个字段把半条答案继续显示（chatReducer.ts:90-92 的说明）。
  // 没被比过的字段：start 之后的 status:'streaming'、meta 带回来的 conversationId
  it('accumulates deltas and marks the answer done', () => {
    let state = chatReducer(initialChatState, {
      type: 'start',
      requestId: 'r1',
      userText: '问题',
    });
    state = chatReducer(state, {
      type: 'meta',
      requestId: 'r1',
      conversationId: 'c1',
      sources: [source],
    });
    state = chatReducer(state, { type: 'delta', requestId: 'r1', text: '你' });
    state = chatReducer(state, { type: 'delta', requestId: 'r1', text: '好' });
    state = chatReducer(state, {
      type: 'done',
      requestId: 'r1',
      conversationId: 'c1',
      cancelled: false,
    });
    expect(state.assistantText).toBe('你好');
    expect(state.sources).toEqual([source]);
    expect(state.status).toBe('done');
    expect(state.cancelled).toBe(false);
  });

  // 回归点：requestId 闸门（chatReducer.ts:77）——这是防「串台」的唯一一处：
  // 用户点了停止、旧请求的尾包还在路上，或者连发两问时前一条的 delta 迟到，
  // 不拦就会把内容混进新回答。断言只取 assistantText 一个字段；
  // 没断言的是「闸门命中的是原对象原样返回」——那句 `return state` 只有身份比较
  // （expect(next).toBe(前一个 state)）才测得出来，这里用的是字段比较；
  // meta/done/error 走同一句闸门，也一律没有用例
  it('ignores events from another request', () => {
    const state = chatReducer(initialChatState, {
      type: 'start',
      requestId: 'r1',
      userText: '问题',
    });
    const next = chatReducer(state, {
      type: 'delta',
      requestId: 'r2',
      text: '不应出现',
    });
    expect(next.assistantText).toBe('');
  });

  // 回归点：服务端把异常统一翻成 chat:error 的中文文案（realtime.gateway.ts#chatSend 第 10a 步），
  // reducer 必须把它落到 error 字段并把状态推到 'error'，否则气泡会永远显示「正在生成」。
  // 这条用例是在【还没有任何 delta】的情况下派发 error 的，
  // 所以「出错时保留已生成的半条正文」（error 分支同样是展开旧 state）这个行为并没有被测到
  it('records errors', () => {
    let state = chatReducer(initialChatState, {
      type: 'start',
      requestId: 'r1',
      userText: '问题',
    });
    state = chatReducer(state, {
      type: 'error',
      requestId: 'r1',
      message: '生成失败',
    });
    expect(state.status).toBe('error');
    expect(state.error).toBe('生成失败');
  });
});
