/**
 * 产品标识（图标 + "Atlas / Knowledge workspace" 文字），出现在侧边栏、认证页和错误页。
 * 边界：纯展示，不是链接也不跳转——可点击的首页链接由调用方包在外面（AppShell.tsx:137 的
 * <Link to="/" aria-label="Atlas 首页">）；名字文案就写死在本文件里，换品牌名只改这里。
 */
import { Layers3 } from 'lucide-react';
import { cn } from '../../lib/cn';

/**
 * 品牌标识。
 * 步骤：
 * 1. 渲染主色方块 + 层叠图标，右上角叠一颗绿色状态点
 * 2. compact 为真时只留方块（窄栏/移动端顶栏用），否则再叠两行文字
 * 3. 按 light 切换两行文字的深浅配色
 * light 对应深色底场景：侧边栏（AppShell）与认证页左栏是深色的，正文区是浅色的；
 * 只影响那两行文字，方块本身在两种背景下都用同一个主色。
 * 状态点用 ring-sidebar（@theme 里的 --color-sidebar，styles/index.css:11）描一圈与侧边栏同色的环，
 * 让圆点看起来是从方块上「抠」出来的——这圈颜色只对深色侧边栏成立；浅色底场景
 * （StatusPages.tsx:19、OrgOnboardingPage.tsx:43）里它会显示成一道深色描边，属于现状而非 bug。
 */
export function Logo({
  light = false,
  compact = false,
  className,
}: {
  light?: boolean;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center gap-3', className)}>
      <div className="relative flex h-9 w-9 items-center justify-center rounded-xl bg-accent text-white shadow-lg shadow-indigo-950/25">
        <Layers3 className="h-5 w-5" strokeWidth={2.1} />
        <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-emerald-400 ring-2 ring-sidebar" />
      </div>
      {!compact ? (
        <div className="leading-tight">
          <div className={cn('text-[15px] font-semibold tracking-tight', light ? 'text-white' : 'text-ink')}>
            Atlas
          </div>
          <div className={cn('text-[11px]', light ? 'text-slate-400' : 'text-soft')}>
            Knowledge workspace
          </div>
        </div>
      ) : null}
    </div>
  );
}
