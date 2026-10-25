/**
 * 上传投放区：既支持拖拽也支持点击选择，只负责把选中的 File[] 交给 onFiles。
 *
 * 边界：
 * - 不做大小/类型校验（accept 只是浏览器的选择过滤），20MB 限制与错误提示在 DocumentsPage 里；
 *   上传请求也由父组件的 mutation 发出
 * - disabled 或 busy 为真时同时禁用输入框、按钮和拖拽态；查看权限的用户根本不会渲染本组件
 *   （DocumentsPage 改为显示只读说明），所以当前唯一调用方从不传 disabled
 */
import { useRef, useState } from 'react';
import { FileUp, Loader2, UploadCloud } from 'lucide-react';
import { UPLOAD_ACCEPT } from '../../lib/api';
import { cn } from '../../lib/cn';

/**
 * 上传区。
 * 步骤：
 * 1. 拖拽进入时置 dragging 高亮（仅在可用状态），离开或放下即复位
 * 2. 放下/选择文件后交给 pick → onFiles；multiple 允许一次传多个
 * 3. pick 末尾清空 input.value：否则再次选择同一个文件不会触发 change
 */
export function UploadDropzone({
  disabled = false,
  busy = false,
  uploadingName,
  onFiles,
}: {
  disabled?: boolean;
  busy?: boolean;
  uploadingName?: string | null;
  onFiles: (files: File[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const pick = (files: FileList | null) => {
    if (!files?.length) return;
    onFiles(Array.from(files));
    // 清空选择值，保证「同一个文件再选一次」也能触发 change
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <div
      onDragOver={(event) => {
        event.preventDefault();
        if (!disabled && !busy) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        if (!disabled && !busy) pick(event.dataTransfer.files);
      }}
      className={cn(
        'relative overflow-hidden rounded-2xl border border-dashed p-6 transition sm:p-7',
        dragging
          ? 'border-accent bg-accent-soft/60'
          : 'border-line-strong bg-white/70 hover:border-accent/40 hover:bg-white',
        (disabled || busy) && 'opacity-80',
      )}
    >
      {/* 隐藏的原生 file input：accept 只影响选择框的默认过滤，仍可能被改成「所有文件」，服务端还会再验 */}
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={UPLOAD_ACCEPT}
        className="sr-only"
        disabled={disabled || busy}
        onChange={(event) => pick(event.target.files)}
      />
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-accent">
          {busy ? <Loader2 className="h-6 w-6 animate-spin" /> : <UploadCloud className="h-6 w-6" />}
        </div>
        <div>
          <p className="text-sm font-medium text-ink">
            {busy ? `正在上传${uploadingName ? `：${uploadingName}` : '…'}` : '拖拽文档到这里，或点击上传'}
          </p>
          <p className="mt-1 text-xs text-muted">
            支持 TXT、MD、PDF、DOCX，单文件不超过 20MB。可一次选择多个文件。
          </p>
        </div>
        <button
          type="button"
          disabled={disabled || busy}
          onClick={() => inputRef.current?.click()}
          className="inline-flex items-center gap-2 rounded-xl border border-line bg-white px-3.5 py-2 text-xs font-medium text-ink shadow-sm transition hover:border-line-strong hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <FileUp className="h-3.5 w-3.5" />
          选择文件
        </button>
      </div>
    </div>
  );
}
