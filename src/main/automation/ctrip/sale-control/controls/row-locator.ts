/**
 * sale-control 模块的行级 locator 工具：
 *   - findRowByTitle：在 saleControl-body / ant-form-item 中按 title 定位一行；
 *     同时覆盖旧版 .saleControl-body .ant-row 和新版 .ant-form-item label[title]，
 *     容忍末尾「*」必填标记。
 *   - waitForRowEnabledSelect：等指定 row 内出现至少一个 ant-select-enabled（合同未禁用前不能点）；
 *   - rowHasSelectedLabel / waitForRowSelectedLabel：核验下拉选中结果是否生效。
 */

import { delay, escapeRegExp } from "../../utils.js";
import type { VbkLocator, VbkPage } from "../../locator-types.js";

/**
 * 在 saleControl-body 里按 title 文本精确匹配定位一行（容忍末尾「*」必填标记）。
 * 用 escapeRegExp 包裹 label，保证 label 含元字符时也不会被 RegExp 误匹配。
 */
export function findRowByTitle(page: VbkPage, label: string): VbkLocator {
  const legacyRow = page
    .locator(".saleControl-body .ant-row")
    .filter({
      has: page.locator(".saleControl-title", { hasText: new RegExp(`^\\s*${escapeRegExp(label)}\\s*\\*?\\s*$`) }),
    })
    .first();

  // 新版页面把「是否拼小团」等动态字段放在 ant-form-item，标题是
  // label[title]，不在 .saleControl-body 的旧 ant-row 中。
  const modernRow = page
    .locator(".ant-form-item")
    .filter({ has: page.locator(`label[title="${label.replaceAll('"', '\\"')}"]`) })
    .first();
  // first() 保证过渡渲染短暂并存两套结构时只操作页面顺序靠前的一行，
  // 不会把两组 checkbox 合并为一个列表。
  return legacyRow.or(modernRow).first();
}

/**
 * 等指定 row 内出现至少一个「可点击」的 ant-select-enabled（合同未禁用前不能点），
 * 最多等 timeoutMs 默认 5s，返回是否等到。
 */
export async function waitForRowEnabledSelect(_page: VbkPage, row: VbkLocator, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const selector = ".ant-select.ant-select-enabled";
  while (Date.now() < deadline) {
    const count = await row.locator(selector).count();
    if (count > 0) return true;
    await delay(200);
  }
  return false;
}

export async function rowHasSelectedLabel(row: VbkLocator, label: string): Promise<boolean> {
  const selectedValues = row.locator(".ant-select-selection-selected-value, .ant-select-selection-item");
  const count = await selectedValues.count();
  for (let index = 0; index < count; index += 1) {
    const selected = selectedValues.nth(index);
    const text = (
      (await selected.getAttribute("title").catch(() => "")) ||
      (await selected.innerText().catch(() => "")) ||
      ""
    ).trim();
    if (text === label) return true;
  }
  return false;
}

export async function waitForRowSelectedLabel(row: VbkLocator, label: string, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await rowHasSelectedLabel(row, label)) return true;
    await delay(200);
  }
  return await rowHasSelectedLabel(row, label);
}