// @ts-nocheck

import { delay, escapeRegExp } from "../utils.js";

export function dayScopeFor(titleInput) {
  return titleInput.locator(
    'xpath=ancestor::*[contains(@class,"td-day-item--")][1]',
  );
}

export async function ensureOtherCard(page, dayScope, { afterFirstCard = false } = {}) {
  const otherCards = dayScope
    .locator('[class*="td-day-card--"]')
    .filter({ hasText: "其他" });
  while ((await otherCards.count()) > 1) {
    const before = await otherCards.count();
    await otherCards.last().getByText("删除", { exact: true }).click({ force: true });
    await delay(300);
    const confirm = page.getByText("确定", { exact: true });
    for (let index = (await confirm.count()) - 1; index >= 0; index -= 1) {
      if (await confirm.nth(index).isVisible()) {
        await confirm.nth(index).click({ force: true });
        break;
      }
    }
    for (let attempt = 0; attempt < 20 && (await otherCards.count()) >= before; attempt += 1) {
      await delay(100);
    }
  }
  if (await otherCards.count()) return otherCards.first();

  const addBoxes = dayScope.locator('[class*="td-add-box"]');
  const addBox = addBoxes.nth(afterFirstCard ? 1 : 0);
  await addBox.locator('[class*="td-add-plus-btn"]').click();
  await delay(500);
  const menuItem = addBox
    .locator('[class*="td-add-item-btn-new"]')
    .filter({ hasText: "其他" });
  let clicked = false;
  for (let index = 0; index < (await menuItem.count()); index += 1) {
    if (await menuItem.nth(index).isVisible()) {
      await menuItem.nth(index).click();
      clicked = true;
      break;
    }
  }
  if (!clicked) throw new Error('新增菜单已打开，但找不到可点击的“其他”节点');
  await otherCards.first().waitFor({ state: "visible", timeout: 8_000 });
  return otherCards.first();
}

export async function ensureServiceTimeRange(dayScope, day) {
  const label = dayScope.getByText("可服务时间段", { exact: true });
  if (!(await label.count())) return;
  const formItem = label.locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' ant-form-item ')][1]");
  if (!(await formItem.count())) return;
  const checkedRadios = formItem.locator("span.ant-radio-checked");
  const isChecked = (await checkedRadios.count()) > 0;
  const timeInputs = formItem.locator("input.ant-time-picker-input");
  const timeCount = await timeInputs.count();
  const timeValues = [];
  for (let index = 0; index < timeCount; index += 1) {
    const val = await timeInputs.nth(index).getAttribute("value");
    timeValues.push((val || "").trim());
  }
  const allTimeEmpty = !timeValues.length || timeValues.every((item) => item.length === 0);
  if (isChecked || !allTimeEmpty) return;
  const setAllDay = await clickByCandidates(formItem, ["全天"], `第 ${day.day} 天可服务时间段`);
  if (!setAllDay) {
    console.warn(`[ensureServiceTimeRange] 第 ${day.day} 天可服务时间段未命中"全天"选项，暂不处理`);
  }
}

export async function clickExact(scope, label, description = label) {
  const matches = scope.getByText(label, { exact: true });
  const count = await matches.count();
  for (let index = 0; index < count; index += 1) {
    const match = matches.nth(index);
    if (!(await match.isVisible().catch(() => false))) continue;
    if ((await match.getAttribute("aria-selected").catch(() => null)) === "true") return;
    await match.click({ force: true });
    return;
  }
  throw new Error(`找不到可点击的${description}`);
}

export async function clickByCandidates(scope, labels, description = "候选项") {
  const candidates = Array.isArray(labels) ? labels : [labels];
  for (const label of candidates) {
    const exact = scope.getByText(label, { exact: true });
    for (let index = 0; index < (await exact.count()); index += 1) {
      const match = exact.nth(index);
      if (!(await match.isVisible().catch(() => false))) continue;
      await match.click({ force: true });
      return true;
    }
    const loosePattern = new RegExp(escapeRegExp(label).replace(/\\s+/g, "\\\\s*"));
    const looseMatches = scope.getByText(loosePattern);
    for (let index = 0; index < (await looseMatches.count()); index += 1) {
      const match = looseMatches.nth(index);
      if (!(await match.isVisible().catch(() => false))) continue;
      await match.click({ force: true });
      return true;
    }
  }
  return false;
}

export async function cardsByPrefix(dayScope, prefix) {
  const base = dayScope.locator('[class*="td-day-card--"]');
  const all = await base.all();
  const indices: number[] = [];
  for (let i = 0; i < all.length; i += 1) {
    const handle = all[i];
    const cls = (await handle.getAttribute("class")) || "";
    if (/td-day-card-(list|hd|bd|additembtn)/.test(cls)) continue;
    const text = (await handle.textContent())?.trim() || "";
    if (text.startsWith(prefix)) indices.push(i);
  }
  return indices.map((idx) => base.nth(idx));
}

export async function clickLabelExact(scope, label, description = label) {
  const labels = scope.locator("label").filter({ hasText: label });
  for (let index = 0; index < (await labels.count()); index += 1) {
    const text = (await labels.nth(index).allTextContents()).join("").trim();
    if (text === label && (await labels.nth(index).isVisible())) {
      await labels.nth(index).click({ force: true });
      return;
    }
  }
  throw new Error(`找不到${description}标签`);
}

export async function ensureCheckboxChecked(checkbox) {
  const parentClass = (await checkbox.locator("xpath=..").getAttribute("class")) ?? "";
  if (!parentClass.includes("ant-checkbox-checked")) {
    await checkbox.click({ force: true });
  }
}

