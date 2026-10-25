/**
 * 把文本写进系统剪贴板：一条现代路径 + 一条老浏览器兜底路径。
 * 边界：只负责「复制」这一件事——不弹 toast、不记日志、不重试，失败一律抛异常，
 * 怎么告诉用户由调用方决定。全站只有本文件碰 navigator.clipboard
 * （grep apps/web/src 只命中这里），所以三处调用点的降级行为是一致的：
 * features/organizations/OrgMembersPage.tsx:132 与 features/knowledge-bases/KbMembersPage.tsx:399
 * 复制邀请链接、features/organizations/OrgSettingsPage.tsx:43 复制组织 id。
 */
export async function copyText(text: string): Promise<void> {
  // 首选异步 Clipboard API：要求安全上下文（https 或 localhost），成功就直接返回。
  // 注意这条路径一旦存在就不再回退——API 在场但权限被拒时 reject 的也是它，调用方会收到异常
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // 兜底路径（navigator.clipboard 不存在时才会走到，例如 http 明文部署或老浏览器）。步骤：
  // 1. 造一个临时 textarea 装文本
  // 2. position:fixed + opacity:0 把它藏起来：既不闪一下，也不会把页面顶开或引起滚动跳动
  // 3. focus + select 产生选区——execCommand('copy') 只认选区，没有选区就什么都复制不到
  // 4. 复制完立刻移除节点；返回 false 时抛错，与上面那条路径保持同一个「失败即抛」契约
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  const successful = document.execCommand('copy');
  document.body.removeChild(textarea);
  if (!successful) throw new Error('copy failed');
}
