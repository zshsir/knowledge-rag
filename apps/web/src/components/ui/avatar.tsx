/**
 * 文字头像：一个圆形色块 + 姓名缩写，全站不用图片头像时的唯一画法。
 * 边界：不加载、不渲染任何远程图片（后端也没存头像 URL），缩写规则本身不在这里——
 * 交给 lib/format.ts 的 initials()（本文件是它目前唯一的调用方），所以改缩写规则只需动那一处。
 * 调用方：AppShell（侧边栏用户菜单、移动头）、OrgSwitcher、OrgMembersPage、KbMembersPage、ChatPage。
 */
import { cn } from '../../lib/cn';
import { initials } from '../../lib/format';

/** 五组「浅底+深字」配色；选哪一组只由名字决定，见下面 Avatar 里的哈希 */
const palettes = [
  'bg-indigo-100 text-indigo-700',
  'bg-emerald-100 text-emerald-700',
  'bg-amber-100 text-amber-700',
  'bg-rose-100 text-rose-700',
  'bg-sky-100 text-sky-700',
];

/**
 * 圆形文字头像。
 * 步骤：
 * 1. 把名字每个字符的 charCode 累加成哈希，再对配色表长度取模取一套颜色
 * 2. 按 size 选直径与字号，交给 cn() 拼类名
 * 3. 内容用 initials(name) 渲染（空名字会拿到 "?"，见 format.ts）
 * 为什么用名字哈希而不是用户 id：这里没有别的输入可用，而同一份名字永远算出同一个值——
 * 于是同一个人在侧边栏、成员列表、对话里始终是同一个颜色，也不需要后端补字段。
 * 代价是同名的两个人会同色，名字改动会换色。
 * aria-hidden 的取舍：头像里的缩写只是姓名的重复装饰，读屏靠旁边的姓名文本即可
 * （OrgSwitcher.tsx:56-57、AppShell.tsx:209-213 都是「头像 + 紧邻的姓名文本」）。
 */
export function Avatar({
  name,
  size = 'md',
  className,
}: {
  name: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const hash = Array.from(name).reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const palette = palettes[hash % palettes.length];
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full font-semibold',
        size === 'sm' && 'h-7 w-7 text-[10px]',
        size === 'md' && 'h-9 w-9 text-xs',
        size === 'lg' && 'h-11 w-11 text-sm',
        palette,
        className,
      )}
      aria-hidden
    >
      {initials(name)}
    </span>
  );
}
