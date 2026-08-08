/**
 * 外部链接打开助手：openExternalUrl 会校验 URL 形如 http(s) 之后调用注入的 opener
 * （默认为 Electron 的 shell.openExternal）。在 UI 路由层调用，依赖注入便于单测。
 */

type OpenExternal = (url: string) => Promise<unknown>;

/**
 * 校验并打开外部 HTTP/HTTPS 链接：先 trim + 非空校验，再用 URL 解析并强制协议为 http(s)，
 * 最后调用注入的 openExternal（通常是 Electron shell.openExternal）打开。
 * 任何不合规的输入都抛出本地化错误文案，用于 UI 直接给用户提示。
 */
export async function openExternalUrl(url: string, openExternal: OpenExternal) {
  const value = typeof url === "string" ? url.trim() : "";
  if (!value) throw new Error("当前页面没有可打开的地址。");

  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error("当前页面地址格式不正确。"); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("仅支持打开 HTTP 或 HTTPS 页面。");
  }

  await openExternal(parsed.toString());
}
