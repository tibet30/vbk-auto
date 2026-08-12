// @ts-nocheck
/**
 * 行程描述阶段 URL 判定：精准命中 VBK 套餐管理页。
 *   - 真实 VBK 跳转目标 URL 形如：
 *       https://vbooking.ctrip.com/ivbk/vendor/packageManage?productid=...&from=vbk
 *     （在 VBK tourdays 页「存为草稿 / 提交审核并下一步」之后，
 *      WebContents URL 直接落到上述路径，跨页面后套餐 tab 不存在，
 *      需要靠 URL 落点判定「已推进」而不是等 tab 激活）。
 *   - 上一版契约 `isTargetUrl: () => false` 会让真实跳转被判为「未到达
 *     目标」、继续点「下一步」生成 attempt3 噪声；本函数专门用于精准判
 *     定（保留 query）。
 *   - 必须避开下列相似形态（不命中）：
 *       1) pathname 与 PACKAGE_MANAGE_PATH 不严格相等的任意变体（含
 *          packageManageList、packageManage/sub、/extra/packageManage、
 *          大小写不同、中文 tab 名 URL-encoded 等子路径或前缀变体）；
 *       2) pathname 仅出现一次 packageManage 但仍带有尾斜杠
 *          （例如 "/ivbk/vendor/packageManage/"），必须先去掉末尾一个
 *          或多个斜杠再严格比较；
 *       3) packageManage 仅出现在 query 串（如 ?ref=packageManage），
 *          而 pathname 中并不严格等于 PACKAGE_MANAGE_PATH；
 *       4) 其它 origin（防止 mock / 第三方站点误中）；
 *       5) 旧的 baseInfoMerge（基本信息页）路径段；
 *       6) 空 / 非字符串输入或解析失败的 URL。
 */

export const PACKAGE_MANAGE_ORIGIN = "https://vbooking.ctrip.com";
export const PACKAGE_MANAGE_PATH = "/ivbk/vendor/packageManage";

/**
 * 判定 url 字符串是否对应 VBK 套餐管理页（vbooking.ctrip.com origin +
 * pathname 去掉末尾一个或多个斜杠后严格等于 PACKAGE_MANAGE_PATH）。
 * query 段不参与判定。
 *
 * @param {unknown} url Playwright `page.url()` 返回值（绝对 URL 字符串）。
 * @returns {boolean}
 */
export function isPackageManageUrl(url) {
  if (typeof url !== "string" || !url) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.origin !== PACKAGE_MANAGE_ORIGIN) return false;
  // pathname 必须严格等于 PACKAGE_MANAGE_PATH；允许去掉末尾一个或多个
  // 斜杠后再比较（如 "/ivbk/vendor/packageManage/" 或
  // "/ivbk/vendor/packageManage///"），但其它任何子路径 / 前缀 / 大小写
  // 变体 / 中文 tab 名 URL-encoded 形式都得拒绝。
  const normalizedPath = parsed.pathname.replace(/\/+$/, "");
  return normalizedPath === PACKAGE_MANAGE_PATH;
}
