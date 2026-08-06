// @ts-nocheck

import { delay, assertCount } from "../utils.js";
import { findFirstEnabledOptionIndex, findButlerOptionIndex } from "../../schema/schema-functions.js";

export async function fillServicePhone(page, phone) {
  const target = (phone || "").trim();
  if (!target) throw new Error("线上 400 电话（servicePhone）未配置，无法继续录入。");
  const labelLocator = page.locator("label[for=\"baseInfo.phone400\"]");
  await assertCount(labelLocator, 1, "线上 400 电话 label[for=baseInfo.phone400]");
  const formItem = labelLocator.locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' ant-form-item ')][1]");
  await assertCount(formItem, 1, "线上 400 电话 .ant-form-item");
  await formItem.waitFor({ state: "visible", timeout: 10_000 });
  await page.evaluate(() => {
    const el = document.querySelector('label[for="baseInfo.phone400"]')?.closest('.ant-form-item');
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.top < 0 || rect.bottom > (window.innerHeight || document.documentElement.clientHeight || 0)) {
      el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      const form = document.querySelector('.ant-form');
      if (form && form.scrollHeight > form.clientHeight) {
        form.scrollTop = Math.max(0, el.offsetTop - form.clientHeight / 2);
      }
      const main = document.querySelector('.vbk_layout_layout-main');
      if (main && main.scrollHeight > main.clientHeight) {
        main.scrollTop = Math.max(0, el.offsetTop - main.clientHeight / 2);
      }
    }
  });
  const trigger = formItem.locator(".ant-select-selection[role='combobox']");
  await assertCount(trigger, 1, "线上 400 电话 combobox");
  await trigger.click();
  await delay(400);
  const options = page.locator(
    ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option, " +
    ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-dropdown-menu-item",
  );
  await options.first().waitFor({ state: "visible", timeout: 8_000 }).catch(() => {});
  const total = await options.count();
  const texts = (await options.allTextContents()).map((text) => text.trim());
  const disableds = await Promise.all(
    Array.from({ length: total }, async (_, index) => {
      const cls = (await options.nth(index).getAttribute("class")) || "";
      return /ant-select-item-disabled|ant-select-dropdown-menu-item-disabled/.test(cls);
    }),
  );
  const matchIndex = texts.findIndex((text, index) => text === target && !disableds[index]);
  if (matchIndex < 0) {
    throw new Error(`线上 400 电话下拉未找到「${target}」；可选：${texts.filter(Boolean).join("、") || "无"}`);
  }
  await options.nth(matchIndex).click();
  await delay(300);
}

export async function fillAdvanceBooking(page, { days, time }) {
  const labelLocator = page.locator("label[for=\"bookingControls.advanceBooking\"]");
  await assertCount(labelLocator, 1, "提前预订 label[for=bookingControls.advanceBooking]");
  const formItem = labelLocator.locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' ant-form-item ')][1]");
  await assertCount(formItem, 1, "提前预订 .ant-form-item");
  await formItem.waitFor({ state: "visible", timeout: 10_000 });
  const dayInput = formItem.locator("input.ant-input-number-input");
  await assertCount(dayInput, 1, "提前预订天数输入框");
  await dayInput.fill(String(days));
  const timeInput = formItem.locator("input.ant-time-picker-input");
  await assertCount(timeInput, 1, "提前预订时间输入框");
  const [hour, minute] = String(time).split(":");
  if (!hour || !minute) throw new Error(`提前预订时间格式异常：${time}`);
  await timeInput.click();
  const panel = page.locator(".ant-time-picker-panel:visible");
  await panel.waitFor({ state: "visible", timeout: 5_000 });
  const columns = panel.locator(".ant-time-picker-panel-select");
  const columnCount = await columns.count();
  if (columnCount < 2) throw new Error(`提前预订时间面板结构异常：仅找到 ${columnCount} 列`);
  const hourOption = columns.nth(0).locator("li").filter({ hasText: new RegExp(`^${hour}$`) });
  await assertCount(hourOption, 1, `提前预订小时 ${hour}`);
  await hourOption.click();
  const minuteOption = columns.nth(1).locator("li").filter({ hasText: new RegExp(`^${minute}$`) });
  await assertCount(minuteOption, 1, `提前预订分钟 ${minute}`);
  await minuteOption.click();
  await delay(200);
  const committed = await timeInput.inputValue();
  if (committed !== time) throw new Error(`提前预订时间未成功提交：期望 ${time}，实际 ${committed || "空"}`);
}

export async function fillLocalTravelAgency(page) {
  const scope = page.locator("div[id=\"bookingControls.localInfoIds\"]");
  await assertCount(scope, 1, "地接社容器 div#bookingControls.localInfoIds");
  await scope.waitFor({ state: "visible", timeout: 10_000 });
  const selectedChoices = scope.locator(".ant-select-selection__choice");
  if (await selectedChoices.count() > 0) {
    return;
  }
  while (await selectedChoices.count()) {
    const lastChoice = selectedChoices.nth((await selectedChoices.count()) - 1);
    const remove = lastChoice.locator(".ant-select-selection__choice__remove");
    await assertCount(remove, 1, "地接社已选项删除按钮");
    await remove.click({ force: true });
    await delay(150);
  }
  const searchInput = scope.locator("input.ant-select-search__field");
  await assertCount(searchInput, 1, "地接社搜索输入框");
  await searchInput.click();
  await delay(400);

  const options = page.locator(
    ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option, " +
    ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-dropdown-menu-item",
  );
  await options.first().waitFor({ state: "visible", timeout: 8_000 });
  const total = await options.count();
  const texts = (await options.allTextContents()).map((text) => text.trim());
  const disableds = await Promise.all(
    Array.from({ length: total }, async (_, index) => {
      const cls = (await options.nth(index).getAttribute("class")) || "";
      return /ant-select-item-disabled|ant-select-dropdown-menu-item-disabled/.test(cls);
    }),
  );
  const targetIndex = findFirstEnabledOptionIndex(texts, disableds);
  if (targetIndex < 0) {
    throw new Error(`地接社下拉无可用项；请先在 VBK 维护地接社。可选：${texts.filter(Boolean).join("、") || "无"}`);
  }
  await options.nth(targetIndex).click();
  const commitDeadline = Date.now() + 3_000;
  while (Date.now() < commitDeadline && (await selectedChoices.count()) !== 1) {
    await delay(150);
  }
  if ((await selectedChoices.count()) !== 1) {
    throw new Error(`地接社第一项"${texts[targetIndex]}"点击后未成功写入。`);
  }
  const committedText = (await selectedChoices.nth(0).innerText()).trim();
  if (!committedText.includes(texts[targetIndex])) {
    throw new Error(`地接社选中项异常：期望"${texts[targetIndex]}"，实际"${committedText || "空"}"`);
  }
}

export async function fillButlerContact(page, selection) {
  if (!selection || typeof selection !== "object") {
    throw new Error("管家联系人未配置账号固定信息，请在账号设置里维护后重试。");
  }
  const { contactCardId, displayName } = selection;
  if (!Number.isInteger(contactCardId) || contactCardId <= 0) {
    throw new Error("管家联系人 contactCardId 缺失或非法。");
  }
  const scope = page.locator('div[id="bookingControls.vendorBookingAssistant"]');
  await assertCount(scope, 1, "管家联系人容器 div#bookingControls.vendorBookingAssistant");
  await scope.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
  const trigger = scope.getByRole("combobox");
  await assertCount(trigger, 1, "管家联系人 combobox");
  await trigger.click();
  await delay(400);
  const search = scope.locator("input.ant-select-search__field");
  await assertCount(search, 1, "管家联系人搜索输入框");
  if (displayName) await search.fill(displayName);
  await delay(400);
  const options = page.locator(
    ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option, " +
    ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-dropdown-menu-item",
  );
  await options.first().waitFor({ state: "visible", timeout: 8_000 });
  const total = await options.count();
  const collected = await Promise.all(
    Array.from({ length: total }, async (_, index) => {
      const text = (await options.nth(index).innerText().catch(() => "")).replace(/\s+/g, " ").trim();
      const value = await options.nth(index).getAttribute("data-value").catch(() => null);
      const id = await options.nth(index).getAttribute("data-id").catch(() => null);
      return { value: String(value || id || ""), label: text };
    }),
  );
  const targetIndex = findButlerOptionIndex(collected, { contactCardId, displayName });
  if (targetIndex < 0) {
    const texts = collected.map((option) => option.label);
    throw new Error(`管家联系人下拉未找到 ID ${contactCardId}${displayName ? ` / ${displayName}` : ""}；可选：${texts.filter(Boolean).join("、") || "无"}`);
  }
  await options.nth(targetIndex).click();
  await delay(300);
}

