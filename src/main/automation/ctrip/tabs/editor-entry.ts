/**
 * 跨产品入口跳转 + 基本 tab 定位：
 *   - openProductEditor：跳到 productEditorUrl 并等 baseInfoMerge / tourdays 路径之一落点；
 *   - ensureBasicInfoTabVisible：「基本信息」tab 可见性兜底（不可见则按 role=tab 试）。
 *
 * 注意：basic-info/location.ts 仍保留一个 openProductEditor sentinel（source-slicing 占位），
 * 它先于真正的实现出现在源码全文里，basic-info-fixes 测试的 indexOf 切片以此为终点。
 */

import { productEditorUrl } from "../../constants.js";
import type { VbkPage } from "../locator-types.js";

/**
 * 跳到 productEditorUrl 并等 baseInfoMerge / tourdays 路径之一落点：
 *   - 当前已经在这个产品路径上（且不在外层 URL）则不重复跳转，可选 stayOnCurrentTab；
 *   - 通过 window.location.href 在浏览器内导航（保留 CSP / 不走 goto 防误刷新）；
 *   - 落点后等「基本信息」文本出现，便于后续 phase 进一步操作。
 */
async function openProductEditor(
  page: VbkPage,
  productId: string,
  options: { stayOnCurrentTab?: boolean } = {},
): Promise<void> {
  const { stayOnCurrentTab = false } = options;
  const targetUrl = productEditorUrl(productId);
  const current = page.url();
  const sameProduct = current.includes(encodeURIComponent(productId)) || current.includes(productId);
  const onEditorPath = /\/ivbk\/vendor\//.test(current) || /\/product\/input\//.test(current);
  if (sameProduct && onEditorPath) {
    if (stayOnCurrentTab) {
      return;
    }
    await ensureBasicInfoTabVisible(page);
    return;
  }
  await page.evaluate((url) => { window.location.href = url; }, targetUrl);
  await page.waitForURL(
    (url) => {
      const value = url.toString();
      return value.includes("baseInfoMerge") || /\/ivbk\/vendor\/tourdays\?/.test(value);
    },
    { timeout: 30_000 },
  ).catch(() => {});
  await page.getByText("基本信息", { exact: true }).first().waitFor({ timeout: 30_000 });
}

/**
 * 「基本信息」tab 可见性兜底：若当前不可见则按 role=tab 试「基本信息」/「产品信息」点开。
 */
async function ensureBasicInfoTabVisible(page: VbkPage): Promise<void> {
  const visible = await page.getByText("基本信息", { exact: true }).first().isVisible().catch(() => false);
  if (visible) return;
  for (const label of ["基本信息", "产品信息"]) {
    const tab = page.getByRole("tab", { name: label, exact: true });
    if (await tab.count()) {
      await tab.first().click().catch(() => {});
      await page.getByText("基本信息", { exact: true }).first().waitFor({ timeout: 15_000 }).catch(() => {});
      return;
    }
  }
}

export {
  openProductEditor,
  ensureBasicInfoTabVisible,
};
