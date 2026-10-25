/**
 * 危险操作二次确认框：Dialog 的一层固定配方（sm 宽度 + 琥珀色警示条 + 取消/确认两个按钮）。
 * 边界：正文内容写死在本文件里（不可由调用方替换），它不执行确认动作、也不负责关闭自己——
 * onConfirm 只是把调用方的回调接到按钮上，确认后要不要关掉对话框完全由调用方决定；
 * 因此 onConfirm 里通常什么都不关，等异步回调成功再关（例：DocumentsPage.tsx:342-344 只发 DELETE，
 * 真正的关闭在同一个 mutation 的 onSuccess 里，DocumentsPage.tsx:153）。
 * 调用方：DocumentsPage、ChatPage、OrgMembersPage、KbMembersPage（共 6 处）。
 */
import { Button } from './button';
import { Dialog } from './dialog';

/**
 * 受控确认对话框。
 * 步骤：
 * 1. 用 size="sm" 打开 Dialog，标题与描述直接透传（描述在这里是必填，逼调用方把后果说清楚）
 * 2. footer 放两个按钮：取消走 onClose；确认走 onConfirm，并按 danger 决定用红色还是主色
 * 3. busy 同时压住两个按钮——取消按钮 disabled、确认按钮 loading（loading 内部就是 disabled），
 *    于是请求进行中点不动，这就是本组件的防重复提交方式
 * danger 默认 true、confirmLabel 默认「确认删除」：预设是「这是一次破坏性操作」，
 * 非破坏性的确认要显式传 danger={false} 与一个合适的 confirmLabel。
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = '确认删除',
  busy = false,
  danger = true,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description: string;
  confirmLabel?: string;
  busy?: boolean;
  danger?: boolean;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            onClick={onConfirm}
            loading={busy}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-relaxed text-amber-800">
        该操作可能无法撤销，请确认后继续。
      </div>
    </Dialog>
  );
}
