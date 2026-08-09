/**
 * CDP 会同时暴露 Electron 渲染器、空白窗口以及所有 WebContentsView。
 * 自动化只能附着到当前账户的有效 VBK/Ctrip 页面，不能把空白页或本地
 * renderer 当作回退结果。
 */

const allowedHosts = new Set(["vbooking.ctrip.com", "ctrip.com", "www.ctrip.com"]);

export interface CdpPageLike {
  url(): string;
}

export function isAllowedVbkPageUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    return [...allowedHosts].some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

function isVbookingPageUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "https:" || parsed.protocol === "http:")
      && (parsed.hostname === "vbooking.ctrip.com" || parsed.hostname.endsWith(".vbooking.ctrip.com"));
  } catch {
    return false;
  }
}

/**
 * 优先匹配当前 WebContentsView 的 URL；该 URL 无效（例如恢复时的 about:blank）
 * 时，才回退到任一有效的 VBK/Ctrip 页面。
 */
export function selectVbkPage<T extends CdpPageLike>(pages: T[], currentViewUrl: string): T | undefined {
  if (isAllowedVbkPageUrl(currentViewUrl)) {
    const current = pages.find((page) => page.url() === currentViewUrl && isAllowedVbkPageUrl(page.url()));
    if (current) return current;
  }
  // 当前 view 尚未导航时，优先回退到 VBK 后台页。避免 CDP 中同时存在
  // 其它携程页面时，把不具备 VBK 会话上下文的页面用于 POI 请求。
  return pages.find((page) => isVbookingPageUrl(page.url()))
    ?? pages.find((page) => isAllowedVbkPageUrl(page.url()));
}
