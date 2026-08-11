/**
 * VBK 页面 DOM 等待工具。
 * 解决进程重启后 status() 在 SPA 尚未完成客户端渲染时误判未登录的问题。
 */
import type { WebContents } from "electron";

/**
 * 在页面的 DOM 中轮询查找指定文本，带超时。
 * 用于等待 VBK SPA 渲染出"产品列表"等关键标记；在此过程中
 * 若页面被重定向到登录页（URL 含 login/passport），立即终止并返回 false。
 */
export async function waitForDomText(
  wc: WebContents | undefined,
  text: string,
  timeoutMs: number,
): Promise<boolean> {
  if (!wc) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // 轮询期间若页面被重定向到登录页，提前终止。
    const url = wc.getURL();
    if (/login|passport/i.test(url)) return false;
    try {
      const found = await wc.executeJavaScript(
        `document.body?.innerText?.includes(${JSON.stringify(text)}) === true`,
        true,
      );
      if (found) return true;
    } catch {
      // 页面可能正在导航中，executeJavaScript 会抛错，继续重试。
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}
