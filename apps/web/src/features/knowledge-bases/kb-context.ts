/**
 * 知识库子路由共享的上下文形状与读取钩子。
 *
 * 职责与边界：
 * - 提供方只有一个：KbLayout 在 <Outlet context={{ kb, orgId, kbId }}> 上挂值；
 *   消费方是它的子路由页（成员页等），这样各页不必各自再请求一次库详情
 * - 刻意只放「当前库的只读快照 + 两个 id」，不放任何查询函数或 setter：子页要改数据就走自己的 mutation
 * - 不做运行时校验：useOutletContext 只是把上层 context 原样返回，类型断言只影响编译期。
 *   在 KbLayout 子树之外调用会拿到 null（useOutletContext 的默认值），解构时立刻报错——这是使用约束，不是防御点
 */
import { useOutletContext } from 'react-router-dom';
import type { KnowledgeBase } from '../../lib/types';

// kb 是后端已按当前用户 resolve 过的视图（含 effectivePermission / accessMode / 计数），前端不再二次推导
export interface KbOutletContext {
  kb: KnowledgeBase;
  orgId: string;
  kbId: string;
}

/** 读取 KbLayout 通过 Outlet 传下来的上下文；只允许在知识库子路由里调用 */
export function useKbContext(): KbOutletContext {
  return useOutletContext<KbOutletContext>();
}
