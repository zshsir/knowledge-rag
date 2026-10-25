/**
 * 网关 chat:send 的「终止性事件」单测：只守一件事——一次问答无论怎么结束，前端都必须收到一条收场事件。
 *
 * 为什么要有这个文件（而不是只靠 realtime.e2e-spec.ts）：
 * 步骤：
 * 1. 直接 new RealtimeGateway(...)，五个依赖全给最小假对象，绕开 Nest 容器与数据库
 * 2. 手工调 chatSend(socket, payload)：装饰器只是元数据，位置实参照常传，被测的就是网关本体
 * 3. 用 socket.emit 的调用记录断言协议事件，不 mock 网关自己的任何分支
 * 边界：
 * - 只覆盖 chatSend 的收尾分派（成功 / 中断后落库失败 / 真故障），不测握手、限流、房间归属：
 *   那三件事要真 socket.io 才算数，在 test/realtime.e2e-spec.ts
 * - ChatService 是假的：这里测的不是「中断分类怎么算」，而是「run 无论返回还是抛出，
 *   网关都必须发一条终止事件」——后者才是评审 Important #2 的那个洞
 * - 中止一律通过 socket.data.active.controller.abort() 触发，与 chat:cancel（网关的 `#cancel`）
 *   和 handleDisconnect（:217-221）走的是同一个句柄，不另造第二条中断路径
 */
import { RealtimeGateway } from './realtime.gateway';
import { ChatRunParams } from '../chat/chat.service';
import { AuthUser } from '../common/types';

const USER: AuthUser = { id: 'u-1', email: 'a@test.local', name: 'A' };

/** 网关 chatSend 用到的最小 socket 形状：只有 data 与 emit，其余方法本文件不会走到 */
interface FakeSocket {
  data: Record<string, unknown>;
  emit: jest.Mock;
}

/**
 * 造一个可直接调用的网关。
 * 步骤：
 * 1. sessions.verify 恒返回有效会话，把 revalidate（网关的 `#revalidate`）这条路固定成「放行」
 * 2. kbAccess.require 恒成功，把准入检查（`#chatSend` 第 6 步的 kbAccess.require）固定成「有权」——本文件关心的是收尾，不是判权
 * 3. chat.run 由用例给：可以是正常返回、抛出、或抛出前先把 signal abort 掉
 * 4. config / accessEvents 在 chatSend 里不被读取，给空对象占位即可
 */
function buildGateway(run: (params: ChatRunParams) => Promise<unknown>) {
  // data 里预置 rawToken：revalidate（`#revalidate`）第一步就是读它，缺了会被判定「连接该关」，
  // 后面的 chatSend 直接 return，用例就测不到收尾分派了。令牌内容由假 sessions.verify 忽略
  const socket = {
    data: { rawToken: 'raw-1' },
    emit: jest.fn(),
  } as unknown as FakeSocket;
  const gateway = new RealtimeGateway(
    {} as never,
    { verify: async () => ({ user: USER, sessionId: 's-1' }) } as never,
    { require: async () => 'viewer' } as never,
    { run } as never,
    {} as never,
  );
  return { socket, gateway };
}

/** 问题正文固定：本文件不测准入校验，长度/缺参都有 e2e 覆盖 */
function payload() {
  return { orgId: 'o-1', kbId: 'k-1', question: '问题', requestId: 'r-1' };
}

/** 从 emit 调用记录里挑出某个事件的全部载荷，便于断言「发了几条」「发的是哪条」 */
function emitted(socket: FakeSocket, event: string): Record<string, unknown>[] {
  return socket.emit.mock.calls
    .filter((call) => call[0] === event)
    .map((call) => call[1] as Record<string, unknown>);
}

describe('RealtimeGateway.chatSend 终止性事件', () => {
  /**
   * 回归点（评审 Important #2）：用户在生成阶段点停止，而中断收尾的落库自己又失败了。
   * 这一刻的完整事实是：signal 已 abort + run() 抛出。修复前网关的 catch（:385-395）见
   * controller.signal.aborted 为真就「既不 chat:error 也不 chat:done」，于是前端 chatReducer
   * 永远停在 status:'streaming'（ChatPage 只在收到 done 时才退出流式态），气泡一直转圈。
   * 这里断言的正是那条缺失的收场事件：assistantMessageId=null（半条回答没落库成功，
   * 前端只能按「没有助手消息」收尾），conversationId 取 chat:meta 已送出的那个。
   */
  it('中断后落库失败仍然补发一条终止 chat:done', async () => {
    const { socket, gateway } = buildGateway(async (params) => {
      // 复刻 chat.service.ts 的真实顺序：引用先送出，然后才有 delta
      params.onMeta({
        conversationId: 'conv-1',
        userMessageId: 'msg-user',
        sources: [],
      });
      params.onDelta('半条回答');
      // 用与 chat:cancel 完全相同的句柄触发中止
      (socket.data.active as { controller: AbortController }).controller.abort();
      // 中断分类里 messages.insert / conversations.touch 抛错（chat.service.ts#run 生成阶段的 catch）
      throw new Error('insert failed');
    });

    await gateway.chatSend(socket as never, payload() as never);

    expect(emitted(socket, 'chat:done')).toEqual([
      {
        requestId: 'r-1',
        assistantMessageId: null,
        conversationId: 'conv-1',
        cancelled: true,
      },
    ]);
    // 用户主动停止不是故障：这条分支既不能发 chat:error，也不能记成失败
    expect(emitted(socket, 'chat:error')).toEqual([]);
    // active 必须被清掉（`#chatSend` 的 finally，第 11 步），否则这个连接再也发不出第二个问题
    expect(socket.data.active).toBeUndefined();
  });

  /**
   * 反向守门（防止上面那条修复走过头）：没被中止的失败照旧只发 chat:error、绝不补 done。
   * 摘掉 catch 里的 `if (!controller.signal.aborted)` 判据，这条立刻红——
   * 那会把真故障伪装成「答完了」，前端就不显示失败提示了。
   */
  it('非中止的失败仍只发 chat:error，不补 done', async () => {
    const { socket, gateway } = buildGateway(async () => {
      throw new Error('模型不可用');
    });

    await gateway.chatSend(socket as never, payload() as never);

    expect(emitted(socket, 'chat:error')).toEqual([
      { requestId: 'r-1', message: '生成失败，请稍后重试' },
    ]);
    expect(emitted(socket, 'chat:done')).toEqual([]);
    expect(socket.data.active).toBeUndefined();
  });

  /**
   * 守「只发一条终止事件」：run() 正常返回 interrupted:true（两条正常中断路径都是这样）时，
   * done 只能有第 10 步那一条。若把补发逻辑写成「catch 之外再兜一次」就会重复渲染。
   */
  it('run 正常返回中断时只有一条 done', async () => {
    const { socket, gateway } = buildGateway(async () => ({
      conversationId: 'conv-1',
      assistantMessageId: null,
      answer: '',
      sources: [],
      interrupted: true,
    }));

    await gateway.chatSend(socket as never, payload() as never);

    expect(emitted(socket, 'chat:done')).toEqual([
      {
        requestId: 'r-1',
        assistantMessageId: null,
        conversationId: 'conv-1',
        cancelled: true,
      },
    ]);
    expect(emitted(socket, 'chat:error')).toEqual([]);
  });
});
