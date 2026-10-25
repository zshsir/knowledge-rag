/**
 * toTextDeltas 的事件流收敛测试。
 * 边界：直接喂真实的 LangChain StreamEvent（用 @langchain/core 的消息类构造），
 *      不走 ChatOpenAI、不发网络请求；服务层的空增量过滤由 chat-model.service.spec.ts 覆盖。
 * 事件形状对照 node_modules/@langchain/core/dist/tracers/event_stream.js：
 * { event, name, run_id, tags, metadata, data }，增量事件只有 data.chunk。
 */
import {
  AIMessageChunk,
  ChatMessageChunk,
  isAIMessageChunk,
} from '@langchain/core/messages';
import { StreamEvent } from '@langchain/core/tracers/log_stream';
import { toTextDeltas } from './llm.module';

/** 造一条与 streamEvents 输出同形的事件；name/run_id/metadata 是必填字段，值不影响过滤 */
function streamEvent(event: string, data: StreamEvent['data']): StreamEvent {
  return {
    event,
    name: 'ChatOpenAI',
    run_id: 'run-1',
    tags: [],
    metadata: {},
    data,
  };
}

/** 把预置事件包装成 streamEvents 那样的异步可迭代对象 */
function eventStream(events: StreamEvent[]): AsyncIterable<StreamEvent> {
  return (async function* () {
    yield* events;
  })();
}

/** 收干增量生成器，便于对整段输出做一次性断言 */
async function collect(deltas: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const delta of deltas) out.push(delta);
  return out;
}

/**
 * 造一条 ChatMessageChunk 增量。
 * provider 省略 delta.role 时，@langchain/openai 的 converters/completions.js:256,313
 * 会落到 ChatMessageChunk（类型为 generic，role 为 undefined）；
 * 类型定义里 role 必填，这里给占位值——过滤只看消息类型，与 role 取值无关。
 */
function chatChunk(text: string): ChatMessageChunk {
  return new ChatMessageChunk({ content: text, role: 'user' });
}

describe('toTextDeltas', () => {
  it('无 role 的 ChatMessageChunk 增量也要产出（回归：旧实现静默吞掉整段回答）', async () => {
    // 先钉住回归前提：这类增量不是 AI 增量，旧代码的 isAIMessageChunk 过滤必然丢弃它
    expect(isAIMessageChunk(chatChunk('你'))).toBe(false);

    const deltas = toTextDeltas(
      eventStream([
        streamEvent('on_chat_model_stream', { chunk: chatChunk('你') }),
        streamEvent('on_chat_model_stream', { chunk: chatChunk('好') }),
      ]),
    );

    expect(await collect(deltas)).toEqual(['你', '好']);
  });

  // 回归点：放宽到「只要是个消息增量」之后，标准的 AI 增量这条路必须照常产出、顺序不变
  //（这条防的是反向回归：有人把过滤改窄或改坏，正常流式回答也会红）
  it('AIMessageChunk 增量按顺序产出', async () => {
    const deltas = toTextDeltas(
      eventStream([
        streamEvent('on_chat_model_stream', {
          chunk: new AIMessageChunk({ content: '你' }),
        }),
        streamEvent('on_chat_model_stream', {
          chunk: new AIMessageChunk({ content: '好' }),
        }),
      ]),
    );

    expect(await collect(deltas)).toEqual(['你', '好']);
  });

  // 回归点：事件名过滤（llm.module.ts:41）与消息类型收窄（:44）两道闸都要在。
  // 三条 fixture 各挡一种回归：start/chain_start 的 data 里没有 chunk，靠类型收窄挡住；
  // on_chat_model_end 的 output 本身就是消息块，只有事件名过滤能挡住它
  it('非 on_chat_model_stream 事件（开始/结束/尾部 usage 块）不产出任何增量', async () => {
    const deltas = toTextDeltas(
      eventStream([
        streamEvent('on_chat_model_start', { input: { messages: [] } }),
        streamEvent('on_chain_start', { input: {} }),
        // 真实 SSE 末尾只带 usage、正文为空的块，最终落在 on_chat_model_end 的 output 上
        streamEvent('on_chat_model_end', {
          output: new AIMessageChunk({
            content: '',
            usage_metadata: {
              input_tokens: 5,
              output_tokens: 2,
              total_tokens: 7,
            },
          }),
        }),
      ]),
    );

    expect(await collect(deltas)).toEqual([]);
  });
});
