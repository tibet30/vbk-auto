/**
 * 携程图库 suggestPoi / searchImage 协议常量：
 *   - SUGGESTPOI_ENDPOINT / SEARCH_IMAGE_ENDPOINT：固定 URL；
 *   - CTRIP_LIBRARY_BROWSER_REQUEST_TIMEOUT_MS / CTRIP_LIBRARY_EVALUATE_TIMEOUT_MS；
 *   - SEARCH_IMAGE_MAX_PAGE_SIZE：searchImage 单页上限；
 *   - CTRIP_LIBRARY_REFERRER：让浏览器侧 fetch 附上稳定 referrer 命中 SSO；
 *   - emptyHead：构造一份空白 head（cid / ctok 在 evaluate 闭包里从 cookie 注入）；
 *   - clampPageSize：把 pageSize 裁剪到 [1, SEARCH_IMAGE_MAX_PAGE_SIZE]；
 *   - timeoutOrDefault：负数 / NaN / undefined → fallback。
 */

export const SUGGESTPOI_ENDPOINT =
  "https://online.ctrip.com/restapi/soa2/15638/suggestpoi.json";

export const SEARCH_IMAGE_ENDPOINT =
  "https://online.ctrip.com/restapi/soa2/12719/searchImage";

export const CTRIP_LIBRARY_BROWSER_REQUEST_TIMEOUT_MS = 12_000;
export const CTRIP_LIBRARY_EVALUATE_TIMEOUT_MS = 15_000;
export const SEARCH_IMAGE_MAX_PAGE_SIZE = 50;
export const CTRIP_LIBRARY_REFERRER =
  "https://vbooking.ctrip.com/product/input/productImageText?pattern=1&from=vbk";

export function emptyHead(): import("./types.js").CtripLibraryRequestHead {
  return {
    cid: "",
    ctok: "",
    cver: "1.0",
    lang: "01",
    sid: "8888",
    syscode: "09",
    auth: "",
    xsid: "",
    extension: [],
  };
}

export function clampPageSize(value: number): number {
  if (!Number.isInteger(value) || value <= 0) return 20;
  return Math.min(value, SEARCH_IMAGE_MAX_PAGE_SIZE);
}

export function timeoutOrDefault(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : fallback;
}