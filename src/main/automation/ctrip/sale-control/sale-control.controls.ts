// @ts-nocheck
/**
 * sale-control 模块的低层控件 helper（按行 / 按控件类型拆分）：
 *   - findRowByTitle 按 title 文本定位 saleControl-body 里的行；
 *   - waitForRowEnabledSelect 等合同启用的 ant-select 出现；
 *   - setEnabledSelectByLabel / setSplitGroupIfPresent / selectLineBrandFirstOption
 *     安全地点开 / 选下拉（异常走 skipped，不抛错以免阻塞后续阶段）；
 *   - checkAllEnabledDistributionChannels 批量勾选「分销渠道」，跳过途风、泛定制-C 与 disabled 项。
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
 * 配置跟团游 / 半自助的拼小团链路：是否拼小团、是否参加广场拼团、最大拼团人数。
 */
async function setSmallGroupIfPresent(page, { wantSplit = true, joinSquareGroup = true, maxGroupSize = 8 } = {}) {
  const candidates = ["是否拼小团", "是否拆团", "是否独立成团", "支持拆团"];
  for (const label of candidates) {
    const row = findRowByTitle(page, label);
    const count = await row.count();
    if (!count) continue;
    const radio = row.getByRole("radio", { name: wantSplit ? "是" : "否", exact: true });
    const radioCount = await radio.count();
    if (radioCount >= 1) {
      await radio.first().check().catch(() => {});
      if (!(await radio.first().isChecked().catch(() => false))) return { row: label, skipped: "small-group-selection-not-confirmed" };
      if (!wantSplit) return { row: label, selected: "否" };

      const squareRows = ["是否参加广场拼团", "是否参加拼单广场"];
      let squareRow = null;
      for (const squareLabel of squareRows) {
        const candidate = findRowByTitle(page, squareLabel);
        if (await candidate.count()) {
          squareRow = candidate;
          break;
        }
      }
      if (!squareRow) return { row: label, skipped: "square-group-row-not-found" };
      const squareRadio = squareRow.getByRole("radio", { name: joinSquareGroup ? "是" : "否", exact: true });
      if (!(await squareRadio.count())) return { row: label, skipped: "square-group-row-not-found" };
      await squareRadio.first().check().catch(() => {});
      if (!(await squareRadio.first().isChecked().catch(() => false))) return { row: label, skipped: "square-group-selection-not-confirmed" };

      const maxRows = ["最大拼团人数", "最大成团人数"];
      let maxInput = null;
      for (const maxLabel of maxRows) {
        const candidate = findRowByTitle(page, maxLabel).locator("input").first();
        if (await candidate.count()) {
          maxInput = candidate;
          break;
        }
      }
      if (!maxInput) {
        return {
          row: label,
          selected: "是",
          squareGroup: joinSquareGroup ? "是" : "否",
          maxGroupSize: null,
          maxGroupSizeUnavailable: "platform-not-exposed",
        };
      }
      // Ant Design InputNumber 在初始展示值已经是目标值时，直接 fill 同值
      // 不会触发 React onChange，保存 DTO 仍可能保留服务端默认 0。先写入一个
      // 不同的合法值，再写回目标值，确保表单状态真实更新。
      const currentValue = (await maxInput.inputValue().catch(() => "")).trim();
      if (currentValue === String(maxGroupSize)) {
        await maxInput.fill(String(alternateSmallGroupInputValue(maxGroupSize)));
      }
      await maxInput.fill(String(maxGroupSize));
      await maxInput.press("Tab").catch(() => {});
      if ((await maxInput.inputValue().catch(() => "")).trim() !== String(maxGroupSize)) return { row: label, skipped: "max-group-size-not-confirmed" };
      return { row: label, selected: "是", squareGroup: joinSquareGroup ? "是" : "否", maxGroupSize };
    }
  }
  return { skipped: "split-group-row-not-found" };
}

function alternateSmallGroupInputValue(maxGroupSize) {
  return Number(maxGroupSize) === 1 ? 2 : Number(maxGroupSize) - 1;
}

async function readSmallGroupState(page) {
  const splitLabels = ["是否拼小团", "是否拆团", "是否独立成团", "支持拆团"];
  let splitRow = null;
  for (const label of splitLabels) {
    const candidate = findRowByTitle(page, label);
    if (await candidate.count()) {
      splitRow = candidate;
      break;
    }
  }
  if (!splitRow) return { available: false };

  const splitYes = splitRow.getByRole("radio", { name: "是", exact: true }).first();
  const squareLabels = ["是否参加广场拼团", "是否参加拼单广场"];
  let squareRow = null;
  for (const label of squareLabels) {
    const candidate = findRowByTitle(page, label);
    if (await candidate.count()) {
      squareRow = candidate;
      break;
    }
  }
  const squareYes = squareRow?.getByRole("radio", { name: "是", exact: true }).first();
  const maxLabels = ["最大拼团人数", "最大成团人数"];
  let maxInput = null;
  for (const label of maxLabels) {
    const candidate = findRowByTitle(page, label).locator("input").first();
    if (await candidate.count()) {
      maxInput = candidate;
      break;
    }
  }
  return {
    available: true,
    splitGroup: await splitYes.isChecked().catch(() => false),
    squareGroup: squareYes ? await squareYes.isChecked().catch(() => false) : false,
    maxGroupSize: maxInput ? Number(await maxInput.inputValue().catch(() => "")) : NaN,
  };
}

function smallGroupStateMatches(state, maxGroupSize) {
  return state?.available === true
    && state.splitGroup === true
    && state.squareGroup === true
    && Number(state.maxGroupSize) === Number(maxGroupSize);
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
 *   - 跳过「途风」和「泛定制-C」类定制渠道；
 *   - 跳过 disabled 和已勾选项；
 *   - 点完一次后回读状态，不成功时调用 dismissCustomizationModal 关闭可能弹出的泛定制弹层；
 * 返回 picked / skippedDisabled / skippedAlreadyChecked / skippedCustomization / skippedExcluded / total 给上层。
 */
const DISTRIBUTION_CHANNELS_TO_SKIP = new Set(["途风"]);

function shouldSkipDistributionChannel(label) {
  return DISTRIBUTION_CHANNELS_TO_SKIP.has(label) || /^泛定制-C$/.test(label);
}

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
  const skippedExcluded = [];
  for (let index = 0; index < total; index += 1) {
    const label = labels[index] || "";
    // 点击渠道后 VBK 会重渲染 checkbox group，原来的 nth(index) 可能失效；
    // 用渠道文本重新定位，避免最后一项被重排/隐藏后等待不存在的索引。
    if (!label) continue;
    const wrapper = checkboxes.filter({ hasText: label }).first();
    if (!(await wrapper.count())) continue;
    if (shouldSkipDistributionChannel(label)) {
      if (DISTRIBUTION_CHANNELS_TO_SKIP.has(label)) skippedExcluded.push(label);
      else skippedCustomization.push(label);
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

  return { picked, skippedDisabled, skippedAlreadyChecked, skippedCustomization, skippedExcluded, total };
}

export {
  checkAllEnabledDistributionChannels,
  alternateSmallGroupInputValue,
  shouldSkipDistributionChannel,
  findRowByTitle,
  selectLineBrandFirstOption,
  readSmallGroupState,
  setEnabledSelectByLabel,
  setSmallGroupIfPresent,
  setSmallGroupIfPresent as setSplitGroupIfPresent,
  smallGroupStateMatches,
  waitForRowSelectedLabel,
  waitForRowEnabledSelect,
};
