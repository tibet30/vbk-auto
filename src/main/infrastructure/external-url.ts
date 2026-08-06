type OpenExternal = (url: string) => Promise<unknown>;

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
