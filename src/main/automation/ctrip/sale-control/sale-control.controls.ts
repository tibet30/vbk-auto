// @ts-nocheck
import { delay, escapeRegExp } from "../utils.js";
import { dismissCustomizationModal } from "../dialogs.js";
import { findFirstEnabledOptionIndex } from "../../schema/schema-functions.js";

function findRowByTitle(page, label) {
  return page
    .locator(".saleControl-body .ant-row")
    .filter({
      has: page.locator(".saleControl-title", { hasText: new RegExp(`^\s*${escapeRegExp(label)}\s*\*?\s*$`) }),
    })
    .first();
}

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
  await delay(300);
  return { selected: label, description };
}

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
  waitForRowEnabledSelect,
};
