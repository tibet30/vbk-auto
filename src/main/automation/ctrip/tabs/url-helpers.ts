/**
 * VBK URL 路径识别 helpers（纯函数，无运行时依赖）：
 *   - PRODUCT_IMAGE_TEXT_REGEX：产品图文 page path 的片段级匹配；
 *   - isProductImageTextUrl(url)：产品图文 URL 真值表；
 *   - isItineraryUrl(url)：行程描述页（tourdays）URL 真值表。
 *
 * 真实 VBK 跳转目标 URL 形如：
 *   https://vbooking.ctrip.com/ivbk/vendor/productImageText?productId=...
 * 路径段是 productImageText（不一定带尾斜杠），用「前后为 /、?、&
 * 之一」做片段级判断，避免误命中 `vendor/productImageTextList` 这类无关
 * 子路径，也避免误命中查询串里的 productImageText 关键字。
 */
const PRODUCT_IMAGE_TEXT_REGEX = /(^|[/?&])productImageText([/?&]|$)/;

export function isProductImageTextUrl(url: unknown): boolean {
  if (typeof url !== "string" || !url) return false;
  return PRODUCT_IMAGE_TEXT_REGEX.test(url);
}

/** 真实 VBK 行程描述页路径；产品图文保存后刷新可能直接落到这里。 */
export function isItineraryUrl(url: unknown): boolean {
  if (typeof url !== "string" || !url) return false;
  try {
    const parsed = new URL(url);
    return parsed.pathname.replace(/\/+$/, "") === "/ivbk/vendor/tourdays";
  } catch {
    return false;
  }
}

export { PRODUCT_IMAGE_TEXT_REGEX };
