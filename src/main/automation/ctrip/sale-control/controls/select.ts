/**
 * sale-control 模块的下拉控件辅助：
 *   - setEnabledSelectByLabel：在 row 内第一个可用的 ant-select-enabled 里选 label 对应选项；
 *     任何一步异常都返回 skipped 而不是抛错（合同未启用 / 选项不存在都安全跳过）。
 */

import { delay } from "../../utils.js";
import type { VbkLocator, VbkPage } from "../../locator-types.js";
import { waitForRowSelectedLabel } from "./row-locator.js";

export async function setEnabledSelectByLabel(
  page: VbkPage,
  row: VbkLocator,
  label: string,
  description: string,
) {
  const enabledSelect = row.locator(".ant-select.ant-select-enabled").first();
  const count = await enabledSelect.count();
  if (!count) {
    return { skipped: "disabled-by-contract", description };
  }
  await enabledSelect.scrollIntoViewIfNeeded().catch(() => {});

  await enabledSelect.click();
  await delay(400);
  const option = page.getByRole("option", { name: label, exact: true });
  await option.first().waitFor({ state: "visible", timeout: 8_000 }).catch(() => {});
  const optionCount = await option.count();
  if (!optionCount) {
    await page.keyboard.press("Escape").catch(() => {});
    return { skipped: "option-not-found", description };
  }
  await option.first().click();
  const confirmed = await waitForRowSelectedLabel(row, label, 5_000);
  if (!confirmed) {
    return { skipped: "selection-not-confirmed", description, label };
  }
  return { selected: label, description };
}