/**
 * CDP 会同时暴露 Electron 渲染器、空白窗口以及所有 WebContentsView。
 * 自动化只能附着到当前账户的有效 VBK/Ctrip 页面，不能把空白页或本地
 * renderer 当作回退结果。
 */

const allowedHosts = new Set(["vbooking.ctrip.com", "ctrip.com", "www.ctrip.com"]);

export interface CdpPageLike {
  url(): string;
}

export type CdpPageUsabilityCheck<T extends CdpPageLike> = (page: T) => boolean | Promise<boolean>;

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

/**
 * CDP 可能同时保留默认登录 view 和当前账号 view；二者甚至可能拥有相同 URL。
 * 单靠 URL 的同步选择会命中已 detach 的 0×0 页面，导致后续 locator 虽能找到
 * 元素，却永远因为 outside of viewport 无法点击。
 *
 * 这里先按既有 URL 优先级排列候选，再逐个验证页面是否拥有真实可交互视口。
 * 不回退到不可用候选：宁可明确报“未找到可用页面”，也不能在隐藏副本上写入。
 */
export async function selectUsableVbkPage<T extends CdpPageLike>(
  pages: T[],
  currentViewUrl: string,
  isUsable: CdpPageUsabilityCheck<T>,
): Promise<T | undefined> {
  const ordered: T[] = [];
  const append = (page: T) => {
    if (!ordered.includes(page)) ordered.push(page);
  };

  if (isAllowedVbkPageUrl(currentViewUrl)) {
    pages
      .filter((page) => page.url() === currentViewUrl && isAllowedVbkPageUrl(page.url()))
      .forEach(append);
  }
  pages.filter((page) => isVbookingPageUrl(page.url())).forEach(append);
  pages.filter((page) => isAllowedVbkPageUrl(page.url())).forEach(append);

  for (const page of ordered) {
    if (await isUsable(page)) return page;
  }
  return undefined;
}
