/**
 * 点击展开的下拉面板：Dropdown 负责触发与开合，DropdownItem / DropdownSeparator 负责面板里的行。
 * 边界：不用 portal，面板是触发器所在 `relative` 容器里的 absolute 子元素，所以祖先有 overflow-hidden
 * 时会被裁掉，也需要调用方用 panelClassName 自己挪位置；它不管菜单语义（没有 role="menu"/aria-expanded），
 * 也不做方向键导航；面板打开时不会禁用背后的界面。
 * 调用方：AppShell.tsx:203（侧边栏底部的用户菜单）、OrgSwitcher.tsx:21（组织切换）。
 */
import { useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/cn';

/**
 * 受控于自身的下拉。
 * 步骤：
 * 1. 点触发器切 open
 * 2. open 为真时才往 document 挂 mousedown / keydown 两个监听（Effect 返回值里成对卸载），
 *    点容器外或按 Esc 关掉；点触发器自身不算「外部」，因为它在 ref 容器内，那次点击由第 1 步取反
 * 3. 面板打开时才挂载（关闭即卸载），所以面板内容每次都是全新 state
 * children 支持两种写法：节点，或接收 close 的渲染函数。DropdownItem 不会自己关面板，
 * 想在选完项后关闭必须用函数式 children 调 close()——两个调用点都这么写
 * （AppShell.tsx:220 与 OrgSwitcher.tsx:41 的 `{(close) => ...}`）。
 */
export function Dropdown({
  trigger,
  children,
  align = 'left',
  panelClassName,
}: {
  trigger: React.ReactNode;
  children: React.ReactNode | ((close: () => void) => React.ReactNode);
  align?: 'left' | 'right';
  panelClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <div onClick={() => setOpen((value) => !value)}>{trigger}</div>
      {open ? (
        // 面板定位：贴在触发器下方 6px，z-50 压过卡片内容。panelClassName 放在 cn() 的最后一个入参，
        // 于是调用方能覆盖内置项——AppShell.tsx:218 就靠它把面板翻到触发器上方
        // （bottom-[calc(100%+8px)] top-auto：top-auto 覆盖掉内置的 top-[...]，同一组属性只留最后一个）
        <div
          className={cn(
            'absolute top-[calc(100%+6px)] z-50 min-w-52 animate-slide-up rounded-xl border border-line bg-white p-1.5 shadow-xl shadow-slate-900/10',
            // align 决定面板以哪条边对齐触发器：靠近视口右缘的菜单用 right，否则会被顶出屏幕
            align === 'right' ? 'right-0' : 'left-0',
            panelClassName,
          )}
        >
          {typeof children === 'function' ? children(() => setOpen(false)) : children}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 面板里的一行。
 * 步骤：渲染成左对齐、占满面板宽度的 <button>，danger 时换成红色配色（用于退出登录、删除这类项）。
 * 注意：type 写死 button，避免面板被塞进某个表单时误触发提交；点击不会自动关闭面板，见上文。
 */
export function DropdownItem({
  onClick,
  children,
  danger = false,
}: {
  onClick?: () => void;
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm outline-none transition',
        danger
          ? 'text-red-600 hover:bg-red-50'
          : 'text-ink hover:bg-stone-100',
      )}
    >
      {children}
    </button>
  );
}

/** 面板里的分隔线：纯装饰的一根 1px 横线，不承载语义，所以是 div 而不是 hr */
export function DropdownSeparator() {
  return <div className="my-1 border-t border-line" />;
}
