/**
 * 全局轻提示（toast）：一个持有队列的 Provider + 一个供任意组件调用的 useToast hook。
 * 结构：这里刻意没有用 React portal——面板是 Provider 子树里的 fixed + z-[100] 容器，
 * 靠 Provider 挂在应用根部（providers.tsx:25，在 BrowserRouter 之内）来压过页面内容。
 * 边界：只负责展示与自动消失，不合并重复消息、不持久化队列，也不解释业务成败语义；
 * 文案由调用方给全，本文件只提供 success / error / info 三种色调。
 * 调用方：features/** 的页面与弹窗（CreateKbDialog、KbSettingsDialog、DocumentsPage、各成员页等）。
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { cn } from '../../lib/cn';

/** ToastType 是内部三色调的键；ToastInput 是对外调用入参（type 可省略，默认 info） */
type ToastType = 'success' | 'error' | 'info';

/** 队列里的一条：比 ToastInput 多一个自增 id，用作 React key 与定时移除的凭据 */
interface ToastItem {
  id: number;
  title: string;
  description?: string;
  type: ToastType;
}

interface ToastInput {
  title: string;
  description?: string;
  type?: ToastType;
}

interface ToastContextValue {
  toast: (input: ToastInput) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

/** 类型 → 图标 / 色调两张并列的表，新增一种 type 时两处都要补，漏一处会取到 undefined */
const icons = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
};

const styles = {
  success: 'text-emerald-600',
  error: 'text-red-600',
  info: 'text-accent',
};

/**
 * 渲染 children 并在右下角挂出提示面板，同时把 toast() 通过 context 下发。
 * 步骤：
 * 1. items 存队列，nextId 用 ref 而不是 state——它只用来发号，变化不该触发渲染
 * 2. toast() 追加一条并安排 4500ms 后按 id 移除
 * 3. value 用 useMemo 包住，避免 Provider 每次渲染都换一个新对象、连带让所有 useToast 的消费组件重渲染
 * 4. 面板常驻 DOM（哪怕队列为空），条目靠 map 渲染，关闭按钮走 dismiss
 * 队列上限：`current.slice(-4)` 只保留最近 4 条再追加新的，所以同屏最多 5 条，更早的直接被挤掉
 * （挤掉不会留下悬空定时器，因为定时器按 id 过滤，找不到就是空操作）。
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback(
    (input: ToastInput) => {
      const id = nextId.current++;
      setItems((current) => [
        ...current.slice(-4),
        { id, title: input.title, description: input.description, type: input.type ?? 'info' },
      ]);
      // 步骤 2：定时器的起点是「创建时刻」，鼠标悬停不会续期，4500ms 到点即消失
      window.setTimeout(() => dismiss(id), 4500);
    },
    [dismiss],
  );

  const value = useMemo(() => ({ toast }), [toast]);

  // 步骤 4：下面这块 fixed 容器是提示面板，两个要点——
  // 1. aria-live="polite" 要生效，容器必须在内容插入之前就在 DOM 里，所以它永远渲染、
  //    只在内部 map 出条目，而不是「有提示才挂载整块」；新文本会被朗读且不打断用户输入
  // 2. pointer-events-none 是因为容器铺在视口右下角一整条区域，不能挡住底下的界面；
  //    每张卡片自己再用 pointer-events-auto 把关闭按钮恢复成可点
  // 另注意：原生 <dialog> 模态时处在浏览器 top layer，永远画在所有 z-index 之上，
  // 所以对话框仍开着时触发的提示会被压在对话框后面（现有调用点大多在同一次事件里随即关闭，看不出差别）
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed bottom-5 right-5 z-[100] flex w-[min(92vw,360px)] flex-col gap-2"
        aria-live="polite"
      >
        {items.map((item) => {
          const Icon = icons[item.type];
          return (
            <div
              key={item.id}
              className="pointer-events-auto animate-slide-up rounded-xl border border-line bg-white p-3.5 shadow-xl shadow-slate-900/10"
            >
              <div className="flex items-start gap-3">
                <Icon className={cn('mt-0.5 h-4 w-4', styles[item.type])} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink">{item.title}</p>
                  {item.description ? (
                    <p className="mt-0.5 text-xs leading-relaxed text-muted">
                      {item.description}
                    </p>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => dismiss(item.id)}
                  className="rounded p-0.5 text-soft transition hover:text-ink"
                  aria-label="关闭提示"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

/**
 * 取到 toast() 的唯一入口。
 * 步骤：读 context，取不到（组件在 ToastProvider 之外）就直接抛错——这是故意的快速失败，
 * 比静默返回一个什么都不做的函数更容易在开发期暴露漏套 Provider 的挂载点。
 */
export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside ToastProvider');
  return context;
}
