/**
 * 「线路品牌」行处理：
 *   - 已有值直接返回 reused；
 *   - 否则打开下拉挑第一个未禁用且非「暂无数据」项；
 *   - 选项都被禁用 / 都是 placeholder 时抛错，让上层回退到 advisor。
 */

import { delay } from "../../utils.js";
import { findFirstEnabledOptionIndex } from "../../../schema/schema-functions.js";
import type { VbkPage } from "../../locator-types.js";
import { findRowByTitle } from "./row-locator.js";

export async function selectLineBrandFirstOption(page: VbkPage) {
  const row = findRowByTitle(page, "线路品牌");
  await row.waitFor({ state: "visible", timeout: 10_000 });
  const enabledSelect = row.locator(".ant-select.ant-select-enabled").first();
  const enabledCount = await enabledSelect.count();
  if (!enabledCount) return { skipped: "line-brand-disabled" };

  const selectedValue = enabledSelect.locator(".ant-select-selection-selected-value");
  const selectedCount = await selectedValue.count();
  if (selectedCount) {
    const text = (
      (await selectedValue.getAttribute("title")) ||
      (await selectedValue.innerText().catch(() => "")) ||
      ""
    ).trim();
    if (text) return { reused: text };
  }

  await enabledSelect.click();
  await delay(400);
  const options = page.locator(
    ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option, " +
      ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-dropdown-menu-item",
  );
  await options.first().waitFor({ state: "visible", timeout: 8_000 }).catch(() => {});
  const total = await options.count();
  if (!total) {
    await page.keyboard.press("Escape").catch(() => {});
    throw new Error("线路品牌下拉未返回任何选项，请确认 VBK 已维护线路品牌。");
  }
  const texts = (await options.allTextContents()).map((text) => text.trim());
  const disableds = await Promise.all(
    Array.from({ length: total }, async (_, index) => {
      const cls = (await options.nth(index).getAttribute("class")) || "";
      return /ant-select-item-disabled|ant-select-dropdown-menu-item-disabled/.test(cls);
    }),
  );
  const targetIndex = findFirstEnabledOptionIndex(texts, disableds, ["暂无数据", "Not Found"]);
  if (targetIndex < 0) {
    await page.keyboard.press("Escape").catch(() => {});
    throw new Error(`线路品牌下拉无可用项；可选：${texts.filter(Boolean).join("、") || "无"}`);
  }
  await options.nth(targetIndex).click();
  await delay(300);
  return { picked: texts[targetIndex] };
}