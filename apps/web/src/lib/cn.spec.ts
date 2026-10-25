/**
 * cn() 的回归测试：钉住「条件加类」与「Tailwind 冲突消解」这两件事。
 * 为什么值得单独有一条测试：cn 是全站组件唯一的「条件类名合并」出口（components/ui/** 与 features/**
 * 里要按条件拼接、去掉 Tailwind 冲突时才走它；全站只有 21 个文件导入它，多数 className 仍是裸字符串不经它），
 * 它一旦退化，表现不是报错而是「调用方传的类覆盖不掉组件自带样式」——
 * 也就是视觉上偶发错乱、只能靠肉眼发现，属于最难排查的那类前端回归。
 * 两条断言各守一条：
 * - 第一句同时验两件事：`false && 'hidden'` 被丢掉（clsx 的假值过滤），
 *   且同为水平内边距的 px-2/px-4 只留后写的 px-4（tailwind-merge 的语义分组，不是字符串去重）
 * - 第二句验「不冲突的类必须原样都在、且保持入参顺序」：text-sm 与 hidden 分属不同组，
 *   所以输出是 'text-sm hidden'（对象语法 { hidden: true } 也在这句里顺带用到）。
 *   有人把 twMerge 摘掉只留 clsx，第一句会红；若改成「为了消冲突而丢词或重排」的写法，第二句会红
 * 环境说明：vitest 配的是 environment: 'node'（apps/web/vitest.config.ts），没有 jsdom，
 * 所以本文件只做字符串运算的断言，不去渲染任何组件。
 * 未覆盖：对象/数组混合入参的其它形态、自定义色的分组归属（text-ink 这类来自 styles/index.css
 * 的 @theme 声明，tailwind-merge 认不认它没有用例）、以及「传 undefined/null」的分支。
 */
import { describe, expect, it } from 'vitest';
import { cn } from './cn';

describe('cn', () => {
  it('merges conditional and conflicting classes', () => {
    expect(cn('px-2', false && 'hidden', 'px-4')).toBe('px-4');
    expect(cn('text-sm', { hidden: true })).toBe('text-sm hidden');
  });
});
