/**
 * EmbeddingsService 单测：守三条不可回退的入库/检索契约。
 * 1. 批次切分与顺序（16 条一批）——一批返回几条、按什么顺序回来，决定向量与片段的配对；
 *    配对错位是静默错误，写库后看不出来，检索会拿 A 段的向量命中 B 段
 * 2. 数量与维度闸口——数量不符必须炸（同上）；维度不符必须在这里炸，否则要等到
 *    INSERT 进 vector(1024) 列才报错，那时文档已经失败一半
 * 3. 中断（取消）——B6 评审确认 OpenAIEmbeddings@1.7 没有任何受支持的 abort 通道，
 *    检索阶段被「停止生成」打断时调用方要等到 SDK 的 4 次尝试 × 60s 才解阻，
 *    而 realtime.gateway.ts#chatSend 的第 4 步：一条连接同时只允许一个在途流，于是这个用户的会话被彻底占死；
 *    B7 补了「派发前预检 + 与 signal 竞争」两层，最后两条用例就是钉这个修复的
 * 边界：provider 一律用假实现，绝不打真实模型 API——CI 不能依赖外部网络与额度，
 *      也不该烧真实 key；维度取自假 config，不读 .env。真正的 HTTP/SDK 行为不在本文件覆盖范围。
 */
import { EmbeddingsService } from './embeddings.service';
import { LlmError } from './llm.errors';

/** embed() 只读 embedding.dimensions；llm 那段用不到，凑齐形状仅为以后复用 fake 时不踩坑 */
function fakeConfig(dimensions = 1024) {
  return { embedding: { model: 'BAAI/bge-m3', dimensions }, llm: { apiKey: 'k', baseUrl: 'https://x/v1', model: 'm' } } as never;
}

/** 造一条维度正确的向量，所有分量都是 value：便于用分量值反查「这是第几批的第几条」 */
function vector(value: number, dimensions = 1024) {
  return Array.from({ length: dimensions }, () => value);
}

/**
 * 取回 promise 的拒绝原因。
 * 为什么不用 expect(...).rejects.toThrow：传 Error 实例时它只比 message、传类时只比 instanceof，
 * 而中断分类读的是错误对象的 name（ChatService 的 isAbort 用 error.name === 'AbortError'
 * 或 signal.aborted 判取消，检索与生成两段都走它；网关的 catch 只看 signal.aborted，
 * 用来决定「不发 chat:error、不记 warn」），所以要拿到错误对象本身才能断言 name。
 */
async function captureRejection(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error('预期以 rejection 结束，但实际 resolve 了');
    },
    (error: unknown) => error as Error,
  );
}

describe('EmbeddingsService', () => {
  // 回归点：批量顺序 = 结果顺序。B1 评审要求这条必须有判别力，因此用「故障注入式」的
  // 批次标记（每批返回不同数值），把批次调换或批内倒序都能抓出来；
  // 若只断言长度，实现把批次并发化后乱序也照样绿
  it('按 16 条一批调用 provider 并保持顺序', async () => {
    const calls: string[][] = [];
    const provider = {
      embedDocuments: async (texts: string[]) => {
        // 用调用序号标记批次：不同批次的向量值不会重复，批次错位或批内乱序都能被发现
        const callIndex = calls.length;
        calls.push(texts);
        return texts.map((_, itemIndex) => vector(callIndex * 100 + itemIndex));
      },
    };
    const service = new EmbeddingsService(provider as never, fakeConfig());
    const inputs = Array.from({ length: 20 }, (_, i) => `t${i}`);

    const result = await service.embed(inputs);

    expect(calls.map((call) => call.length)).toEqual([16, 4]);
    expect(result).toHaveLength(20);
    // 第 0 批首尾是 0/15，第 1 批首尾是 100/103；任一批次被调换或批内倒序都会失败
    expect([result[0][0], result[15][0], result[16][0], result[19][0]]).toEqual([
      0, 15, 100, 103,
    ]);
  });

  // 回归点：provider 少给/多给一条时必须整批失败（embeddings.service.ts:102）。
  // 不炸的后果是向量与片段错位——库里存下「A 段配 B 向量」，检索结果看起来正常但其实全错。
  // 断言钉 LlmError 类型有实际意义：入库侧只按「是不是 BadRequestException」分永久失败与可重试
  //（ingestion.service.ts:141），嵌入校验错应保持「可重试」，被改成 400 就会让瞬时故障白丢文档
  it('provider 返回数量不匹配时抛 LlmError', async () => {
    const provider = { embedDocuments: async () => [vector(1)] };
    const service = new EmbeddingsService(provider as never, fakeConfig());
    const pending = service.embed(['a', 'b']);
    await expect(pending).rejects.toThrow(LlmError);
    await expect(pending).rejects.toThrow('Embedding 返回数量不正确');
  });

  // 回归点：维度闸口要在写库之前拦住（脏向量进 vector(1024) 列是 INSERT 时才炸）。
  // 断言只匹配 /维度不正确/ 而不钉完整文案，因为后半截会拼上期望维度，属实现细节
  it('维度不符合配置时抛 LlmError（防止脏向量写库）', async () => {
    const provider = { embedDocuments: async (texts: string[]) => texts.map(() => vector(1, 512)) };
    const service = new EmbeddingsService(provider as never, fakeConfig(1024));
    await expect(service.embed(['a'])).rejects.toThrow(/维度不正确/);
  });

  // 回归点：B7（13b）加的「派发前闸门」——signal 早就 abort 时不许再发请求，
  // 否则多批入库会在用户已经叫停后继续烧剩下的批次配额（embeddings.service.ts:93）
  it('信号已中断时在派发前就抛 AbortError，一次 provider 调用都不发出', async () => {
    const provider = {
      embedDocuments: jest.fn(async (texts: string[]) => texts.map(() => vector(1))),
    };
    const service = new EmbeddingsService(provider as never, fakeConfig());
    const controller = new AbortController();
    controller.abort();

    const error = await captureRejection(service.embed(['a', 'b'], controller.signal));

    // name 必须是 AbortError：链路上任一层接住它都能认出是「取消」而不是故障
    // （ChatService 的 isAbort 检索段与生成段都看它；网关只看 signal.aborted，
    //   用它决定「不发 chat:error、不记 warn」）
    expect(error.name).toBe('AbortError');
    // 这条是本用例的重点：派发前拦截，连第一批都不会发出去
    expect(provider.embedDocuments).not.toHaveBeenCalled();
  });

  // 回归点：B6 评审定性的真实缺陷——OpenAIEmbeddings 1.7 不接 signal，请求已在飞时
  // 「停止生成」原本要等 SDK 自己重试耗尽才解阻，而网关一条连接只允许一条在途流；
  // 这条用「race 一个 100ms 计时器」证明调用方当场就拿到失败，把修复前会挂死的写法钉回红线
  it('provider 卡住不返回时 abort 立刻解除调用方阻塞（不会挂住网关）', async () => {
    // 假 provider 模拟 OpenAIEmbeddings 1.7：embedDocuments 只收 texts，忽略 signal，
    // 返回一条永不 settle 的 promise——修复前调用方要一直等到 SDK 自己超时/重试耗尽
    const provider = {
      embedDocuments: jest.fn(() => new Promise<number[][]>(() => undefined)),
    };
    const service = new EmbeddingsService(provider as never, fakeConfig());
    const controller = new AbortController();
    const startedAt = Date.now();

    // 先挂上 handler 再 abort：否则底层那条永不 resolve 的 promise 会变成未处理 rejection
    const settled = captureRejection(service.embed(['a'], controller.signal));
    controller.abort();

    // 用 race + 计时器判「没有挂住」：未修复时这里拿到 'hang' 而不是 rejection，用例立刻失败
    const outcome = await Promise.race([
      settled,
      new Promise<'hang'>((resolve) => setTimeout(() => resolve('hang'), 100)),
    ]);

    expect(outcome).not.toBe('hang');
    expect((outcome as Error).name).toBe('AbortError');
    // 请求确实已经派出去了（不是在派发前被拦住），并且只一批
    expect(provider.embedDocuments).toHaveBeenCalledTimes(1);
    // 宽松的耗时上界：证明调用方等的是「毫秒级」而不是 SDK 的 4 次尝试 × 60s
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });
});
