// @ts-nocheck
/**
 * sale-control 模块的低层控件 helper（按行 / 按控件类型拆分）：
 *   - findRowByTitle 按 title 文本定位 saleControl-body 里的行；
 *   - waitForRowEnabledSelect 等合同启用的 ant-select 出现；
 *   - setEnabledSelectByLabel / setSplitGroupIfPresent / selectLineBrandFirstOption
 *     安全地点开 / 选下拉（异常走 skipped，不抛错以免阻塞后续阶段）；
 *   - checkAllEnabledDistributionChannels 批量勾选「分销渠道」，跳过泛定制-C 与 disabled 项。
 *
 * 头部带 `// @ts-nocheck`，形参 page 是动态传入。
 */
import { delay, escapeRegExp } from "../utils.js";
import { dismissCustomizationModal } from "../dialogs.js";
import { findFirstEnabledOptionIndex } from "../../schema/schema-functions.js";

/**
 * 在 saleControl-body 里按 title 文本精确匹配定位一行（容忍末尾「*」必填标记）。
 * 用 escapeRegExp 包裹 label，保证 label 含元字符时也不会被 RegExp 误匹配。
 */
function findRowByTitle(page, label) {
  return page
    .locator(".saleControl-body .ant-row")
    .filter({
      has: page.locator(".saleControl-title", { hasText: new RegExp(`^\\s*${escapeRegExp(label)}\\s*\\*?\\s*$`) }),
    })
    .first();
}

/**
 * 等指定 row 内出现至少一个「可点击」的 ant-select-enabled（合同未禁用前不能点），
 * 最多等 timeoutMs 默认 5s，返回是否等到。
 */
async function waitForRowEnabledSelect(page, row, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  const selector = ".ant-select.ant-select-enabled";
  while (Date.now() < deadline) {
    const count = await row.locator(selector).count();
    if (count > 0) return true;
    await delay(200);
  }
  return false;
}

async function rowHasSelectedLabel(row, label) {
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

async function waitForRowSelectedLabel(row, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await rowHasSelectedLabel(row, label)) return true;
    await delay(200);
  }
  return await rowHasSelectedLabel(row, label);
}

/**
 * 在该 row 内第一个可用的 ant-select-enabled 里选 label 对应选项；
 * 任何一步异常都返回 skipped 而不是抛错（合同未启用 / 选项不存在都安全跳过）。
 */
async function setEnabledSelectByLabel(page, row, label, description) {
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

/**
 * 找「是否拆团 / 是否独立成团 / 支持拆团」三组候选标题之一，wantSplit=true 时选「是」否则「否」。
 * 任一命中即返回；都没命中返回 skipped = "split-group-row-not-found"。
 */
async function setSplitGroupIfPresent(page, wantSplit) {
  const candidates = ["是否拆团", "是否独立成团", "支持拆团"];
  for (const label of candidates) {
    const row = findRowByTitle(page, label);
    const count = await row.count();
    if (!count) continue;
    const radio = row.getByRole("radio", { name: wantSplit ? "是" : "否", exact: true });
    const radioCount = await radio.count();
    if (radioCount >= 1) {
      await radio.first().check().catch(() => {});
      return { row: label, selected: wantSplit ? "是" : "否" };
    }
  }
  return { skipped: "split-group-row-not-found" };
}

/**
 * 「线路品牌」行处理：若已经有值直接返回 reused；否则打开下拉挑第一个未禁用且非「暂无数据」项。
 * 选项都被禁用 / 都是 placeholder 时抛错，让上层回退到 advisor。
 */
async function selectLineBrandFirstOption(page) {
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

/**
 * 「分销渠道」批量勾选：遍历所有 .ant-checkbox-wrapper，
 *   - 跳过「泛定制-C」类定制渠道；
 *   - 跳过 disabled 和已勾选项；
 *   - 点完一次后回读状态，不成功时调用 dismissCustomizationModal 关闭可能弹出的泛定制弹层；
 * 返回 picked / skippedDisabled / skippedAlreadyChecked / skippedCustomization / total 给上层。
 */
async function checkAllEnabledDistributionChannels(page) {
  const row = findRowByTitle(page, "分销渠道");
  await row.waitFor({ state: "visible", timeout: 10_000 });
  const checkboxes = row.locator(".ant-checkbox-wrapper");
  const total = await checkboxes.count();
  if (!total) throw new Error("分销渠道行未找到任何 .ant-checkbox-wrapper");

  const labels = await Promise.all(
    Array.from({ length: total }, (_, i) =>
      checkboxes.nth(i).evaluate((el) => (el.textContent || "").trim().replace(/\s+/g, " ")),
    ),
  );

  let picked = 0;
  let skippedDisabled = 0;
  let skippedAlreadyChecked = 0;
  const skippedCustomization = [];
  for (let index = 0; index < total; index += 1) {
    const wrapper = checkboxes.nth(index);
    const label = labels[index] || "";
    if (/^泛定制-C$/.test(label)) {
      skippedCustomization.push(label);
      continue;
    }
    const isDisabled = await wrapper.evaluate(
      (el) => el.classList.contains("ant-checkbox-wrapper-disabled")
        || !!el.querySelector(".ant-checkbox-disabled, .ant-checkbox-input[disabled]"),
    ).catch(() => false);
    if (isDisabled) {
      skippedDisabled += 1;
      continue;
    }
    const isChecked = await wrapper.evaluate(
      (el) => el.classList.contains("ant-checkbox-wrapper-checked")
        || !!el.querySelector(".ant-checkbox-checked")
        || (el.querySelector(".ant-checkbox-input")?.checked === true),
    ).catch(() => false);
    if (isChecked) {
      skippedAlreadyChecked += 1;
      continue;
    }

    await wrapper.evaluate((el) => el.click());
    await delay(120);
    const reopened = await wrapper.evaluate(
      (el) => el.classList.contains("ant-checkbox-wrapper-checked")
        || !!el.querySelector(".ant-checkbox-checked")
        || (el.querySelector(".ant-checkbox-input")?.checked === true),
    ).catch(() => false);

    if (reopened) {
      picked += 1;
    } else {
      await dismissCustomizationModal(page);
    }
  }

  return { picked, skippedDisabled, skippedAlreadyChecked, skippedCustomization, total };
}

export {
  checkAllEnabledDistributionChannels,
  findRowByTitle,
  selectLineBrandFirstOption,
  setEnabledSelectByLabel,
  setSplitGroupIfPresent,
  waitForRowSelectedLabel,
  waitForRowEnabledSelect,
};
