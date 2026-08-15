/**
 * VBK 显式导航 helper：解决 beforeunload 拦截导致 ERR_ABORTED 后无法离开页面的问题。
 *
 * 调用方（典型为 VbkBrowser.navigate）传入 webContents 与目标 URL，helper 完成：
 *   - 临时挂一个 webContents.on("will-prevent-unload") 监听器，并在事件回调中
 *     主动调用 event.preventDefault()，让这一次显式 navigate 能离开被
 *     beforeunload 拦截的页面；
 *   - 调用 webContents.loadURL(target)；
 *   - loadURL 抛 ERR_ABORTED 时，按"目标已抵达"规则判断是否视作成功
 *     （允许尾斜杠 / hash 等 URL 标准化差异）；
 *   - 仍未到目标则抛含源 URL / 目标 URL / 实际 URL / code 的明确错误，
 *     不得静默吞错；
 *   - finally 中清理监听器，永不全局永久忽略 beforeunload；
 *   - 不无限重试；
 *   - 仅放行 VBK 白名单 host，避免 helper 被误用于外链。
 *
 * 设计要点：
 *   - 所有前置校验（URL 非空 / 格式合法 / 协议合法 / 命中白名单）全部在挂监听
 *     器之前完成；这样校验失败时不会泄露一个挂着的监听器。
 *   - loadURL 抛非 ERR_ABORTED 错误时原样上抛，不掩盖 transport 细节
 *     （如 ERR_NAME_NOT_RESOLVED、ERR_CONNECTION_RESET、SSL 错误等）。
 *   - loadURL 成功路径也核验 current URL 是否确实抵达目标，防御服务端
 *     重定向到登录页等异常。
 */

import type { Event, WebContents } from "electron";

/** 与 vbk-browser.ts 中的白名单保持一致：仅允许携程域。 */
const ALLOWED_HOSTS = new Set([
  "vbooking.ctrip.com",
  "ctrip.com",
  "www.ctrip.com",
]);

/**
 * 规范化 URL 用于最终地址核验：
 *   - protocol / host 由 URL 构造器自动小写化；
 *   - 去掉 hash（target 不该依赖 fragment 命中）；
 *   - pathname 尾斜杠去除（除根路径 "/"），容忍 target 末尾缺斜杠或
 *     VBK 实际跳转后多一个尾斜杠的常见差异。
 *
 * 解析失败时返回 null，由调用方决定如何处理。
 */
export function normalizeUrlForCompare(value: string): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const pathname = parsed.pathname === "/" ? "/" : parsed.pathname.replace(/\/+$/, "");
  return `${parsed.protocol}//${parsed.host}${pathname}${parsed.search}`;
}

/**
 * 比较两个 URL 是否等价（忽略 hash、规范化尾斜杠）。
 * 任一 URL 解析失败时返回 false（不做宽松匹配，避免掩盖格式错误）。
 */
export function urlsMatch(a: string, b: string): boolean {
  const na = normalizeUrlForCompare(a);
  const nb = normalizeUrlForCompare(b);
  if (na === null || nb === null) return false;
  return na === nb;
}

export interface NavigateVbkPageOptions {
  allowRedirect?: (target: string, current: string) => boolean;
}

function isExpectedLoginRedirect(target: string, current: string): boolean {
  let parsedCurrent: URL;
  try {
    parsedCurrent = new URL(current);
  } catch {
    return false;
  }
  if (parsedCurrent.hostname !== "vbooking.ctrip.com") return false;
  if (!/^\/ivbk\/accountV2\/login$/i.test(parsedCurrent.pathname)) return false;
  const backurl = parsedCurrent.searchParams.get("backurl") ?? "";
  return urlsMatch(target, backurl);
}

/**
 * 显式导航入口。
 *
 * 调用约定：
 *   - 仅在调用期间临时挂一个 will-prevent-unload 监听；
 *   - 监听器在 finally 中按引用清理，不会污染下一次调用；
 *   - 不会全局永久忽略 beforeunload。
 */
export async function navigateVbkPage(
  webContents: WebContents | undefined,
  url: string,
  options: NavigateVbkPageOptions = {},
): Promise<void> {
  if (!webContents) {
    throw new Error("VBK 浏览器尚未初始化");
  }

  const target = typeof url === "string" ? url.trim() : "";
  if (!target) throw new Error("导航目标 URL 不能为空");

  let parsedTarget: URL;
  try {
    parsedTarget = new URL(target);
  } catch {
    throw new Error("导航目标 URL 格式不正确");
  }
  if (parsedTarget.protocol !== "http:" && parsedTarget.protocol !== "https:") {
    throw new Error("仅支持 HTTP / HTTPS 导航目标");
  }
  if (
    ![...ALLOWED_HOSTS].some(
      (host) => parsedTarget.hostname === host || parsedTarget.hostname.endsWith(`.${host}`),
    )
  ) {
    throw new Error("仅允许在内置 VBK 浏览器中打开携程页面");
  }

  // 所有前置校验通过后才挂监听器：校验失败路径不需要 finally 兜底清理。
  const sourceUrl = webContents.getURL();
  const allowUnload = (event: Event) => {
    // will-prevent-unload.preventDefault() 等于「忽略 beforeunload 拦截、放行
    // 这一次离页」。仅在本次显式 navigate 期间挂，finally 必清。
    event.preventDefault();
  };
  webContents.on("will-prevent-unload", allowUnload);

  try {
    try {
      await webContents.loadURL(target);
    } catch (error) {
      const code = (error as { code?: string } | null)?.code ?? "";
      const current = webContents.getURL();
      // ERR_ABORTED 是 beforeunload 拦截 → 离页未发生时的典型 code。
      // 即便我们在 will-prevent-unload 上 preventDefault() 放行，loadURL 在某些
      // Electron 版本 / 竞态下仍可能以 ERR_ABORTED 拒绝；只要当前 URL 已等于
      // 目标（含尾斜杠 / hash 差异），就视作成功，避免上层误判。
      if (code === "ERR_ABORTED" && urlsMatch(target, current)) {
        return;
      }
      if (code === "ERR_ABORTED" && options.allowRedirect?.(target, current)) {
        return;
      }
      if (code === "ERR_ABORTED") {
        const err = new Error(
          `VBK 显式导航被中断: source=${sourceUrl} target=${target} actual=${current} code=${code}`,
        );
        (err as Error & { code?: string }).code = code || "ERR_ABORTED";
        throw err;
      }
      // 其他错误（含 ERR_NAME_NOT_RESOLVED / SSL / network reset 等）原样上抛，
      // 不掩盖 transport 细节，也不冒充成功。
      throw error;
    }

    // loadURL 已成功；核验 current URL 是否确实抵达目标（防御服务端把页面
    // 重定向到登录页等异常场景，避免 UI 误以为"进入"成功）。
    const current = webContents.getURL();
    if (!urlsMatch(target, current) && !options.allowRedirect?.(target, current)) {
      throw new Error(
        `VBK 显式导航未抵达目标: source=${sourceUrl} target=${target} actual=${current}`,
      );
    }
  } finally {
    webContents.off("will-prevent-unload", allowUnload);
  }
}

export { isExpectedLoginRedirect };
