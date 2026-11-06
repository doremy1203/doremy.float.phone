/**
 * 复制文本：壳内优先走原生剪贴板。
 *
 * Android WebView 的 navigator.clipboard 在部分机型/页面状态下会 resolve 但
 * 实际没有写入（用户粘贴为空），所以有 AndroidShell.copyText 时先用原生的。
 */
type ClipboardShell = {
  copyText?: (text: string) => boolean;
};

export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof window === "undefined") return false;
  const shell = (window as unknown as { AndroidShell?: ClipboardShell }).AndroidShell;
  if (shell?.copyText) {
    try {
      if (shell.copyText(text)) return true;
    } catch {
      // 原生失败再试浏览器 API
    }
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 交给调用方提示手动复制
  }
  return false;
}
