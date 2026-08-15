// @ts-nocheck
/**
 * 「基本信息」面板里几个相对独立的小字段段写入 helper：
 *   - fillServicePhone：线上 400 电话（必填，缺则抛错）；
 *   - fillAdvanceBooking：提前预订（天/点几分两个数值控件）；
 *   - fillLocalTravelAgency：地接社已选项（如已选直接 return）；
 *   - fillButlerContact：管家联系人，根据 selection.contactCardId 在下拉里精确定位。
 * 顶部带 `// @ts-nocheck`，page 是动态传入。
 */

import { delay, assertCount, readLocatorSnapshot, getControlledDropdownOptions, clickLocatorSnapshotOption } from "../utils.js";
import { findFirstEnabledOptionIndex, findButlerOptionIndex } from "../../schema/schema-functions.js";
import { NonAdvisableAutomationError } from "../../automation.main/automation.main.errors.js";

const BASIC_INFO_VISIBLE_WAIT_MS = 5_000;
const BASIC_INFO_SEARCH_TIMEOUT_MS = 3_000;
const SERVICE_PHONE_POLL_INTERVAL_MS = 150;

/**
 * 写「线上 400 电话」单选下拉：
 *   - 必传 phone，否则抛错提示缺配置；
 *   - 通过 label[for=baseInfo.phone400] 反查 .ant-form-item；
 *   - 必要时滚动到容器可视区域；
 *   - 在打开的下拉里精确匹配 phone 文本，未匹配到抛错（含可选列表便于运营排查）。
 */
export async function fillServicePhone(page, phone) {
  const target = (phone || "").trim();
  if (!target) throw new Error("线上 400 电话（servicePhone）未配置，无法继续录入。");
  const labelLocator = page.locator("label[for=\"baseInfo.phone400\"]");
  await assertCount(labelLocator, 1, "线上 400 电话 label[for=baseInfo.phone400]");
  const formItem = labelLocator.locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' ant-form-item ')][1]");
  await assertCount(formItem, 1, "线上 400 电话 .ant-form-item");
  await formItem.waitFor({ state: "visible", timeout: BASIC_INFO_VISIBLE_WAIT_MS });
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
  const options = await getControlledDropdownOptions(page, trigger);
  let texts = [];
  // 真实 VBK 会在打开后异步请求账号可用号码；连续新建产品时，候选可能
  // 稍晚才替换“暂无数据”。这里收紧到 3 秒，避免把简单精确匹配拖成长等待。
  const searchDeadline = Date.now() + BASIC_INFO_SEARCH_TIMEOUT_MS;
  while (Date.now() < searchDeadline) {
    await delay(SERVICE_PHONE_POLL_INTERVAL_MS);
    const snapshot = await readLocatorSnapshot(options);
    texts = snapshot.map((option) => option.text);
    const disableds = snapshot.map((option) =>
      /ant-select-item-disabled|ant-select-dropdown-menu-item-disabled/.test(option.className));
    const matchIndex = texts.findIndex((text, index) => text === target && !disableds[index]);
    if (matchIndex >= 0) {
      const clicked = await clickLocatorSnapshotOption(options, snapshot[matchIndex]);
      if (!clicked) {
        await delay(SERVICE_PHONE_POLL_INTERVAL_MS);
        continue;
      }
      await delay(300);
      return;
    }
  }
  throw new NonAdvisableAutomationError(
    `线上 400 电话下拉未找到「${target}」；可选：${texts.filter(Boolean).join("、") || "无"}`,
  );
}

/**
 * 写「提前预订」：
 *   - 天数走数字输入框；
 *   - 时间走 ant-time-picker 面板（小时列 + 分钟列各点一项），提交后回读 inputValue 等于 time；
 *   - 面板结构异常 / 时间未成功提交时抛错。
 */
export async function fillAdvanceBooking(page, { days, time }) {
  const labelLocator = page.locator("label[for=\"bookingControls.advanceBooking\"]");
  await assertCount(labelLocator, 1, "提前预订 label[for=bookingControls.advanceBooking]");
  const formItem = labelLocator.locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' ant-form-item ')][1]");
  await assertCount(formItem, 1, "提前预订 .ant-form-item");
  await formItem.waitFor({ state: "visible", timeout: BASIC_INFO_VISIBLE_WAIT_MS });
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

/**
 * 「地接社」字段：已有已选项 → return；否则清空既有 + 在下拉挑第一个 enabled 选项写入。
 * VBK 必须先在地接社维护里有可用项，否则抛错给上层 advisor。
 */
export async function fillLocalTravelAgency(page) {
  const scope = page.locator("div[id=\"bookingControls.localInfoIds\"]");
  await assertCount(scope, 1, "地接社容器 div#bookingControls.localInfoIds");
  await scope.waitFor({ state: "visible", timeout: BASIC_INFO_VISIBLE_WAIT_MS });
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

  const localCombobox = scope.getByRole("combobox");
  await assertCount(localCombobox, 1, "地接社 combobox");
  const options = await getControlledDropdownOptions(page, localCombobox);
  await options.first().waitFor({ state: "visible", timeout: BASIC_INFO_SEARCH_TIMEOUT_MS });
  const snapshot = await readLocatorSnapshot(options);
  const texts = snapshot.map((option) => option.text);
  const disableds = snapshot.map((option) =>
    /ant-select-item-disabled|ant-select-dropdown-menu-item-disabled/.test(option.className));
  const targetIndex = findFirstEnabledOptionIndex(texts, disableds);
  if (targetIndex < 0) {
    throw new Error(`地接社下拉无可用项；请先在 VBK 维护地接社。可选：${texts.filter(Boolean).join("、") || "无"}`);
  }
  const clicked = await clickLocatorSnapshotOption(options, snapshot[targetIndex]);
  if (!clicked) throw new Error(`地接社候选"${texts[targetIndex]}"在提交前已被页面刷新。`);
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

/**
 * 「管家联系人」按 selection.contactCardId 精确挑选：
 *   - selection 缺失 / 非对象抛错；
 *   - contactCardId 非正整数也抛错；
 *   - 在下拉中拿所有 option 的 data-value / data-id 与 selection.contactCardId 比对，
 *     文本与 id 同时匹配 findButlerOptionIndex；找不到抛错附可选列表。
 */
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
  await scope.waitFor({ state: "visible", timeout: BASIC_INFO_VISIBLE_WAIT_MS }).catch(() => {});
  const trigger = scope.getByRole("combobox");
  await assertCount(trigger, 1, "管家联系人 combobox");
  await trigger.click();
  await delay(400);
  const search = scope.locator("input.ant-select-search__field");
  await assertCount(search, 1, "管家联系人搜索输入框");
  if (displayName) await search.fill(displayName);
  await delay(400);
  const options = await getControlledDropdownOptions(page, trigger);
  await options.first().waitFor({ state: "visible", timeout: BASIC_INFO_SEARCH_TIMEOUT_MS });
  // 下拉打开时会先显示空关键词第一页（最多 50 条），`search.fill()` 后服务端
  // 过滤结果异步替换这一批 DOM。不能看到首项就立即采集，否则会把仍在途的
  // 精确联系人误判为“不存在”。持续读取当前可见候选，直到目标真正出现。
  let collected = [];
  let collectedSnapshot = [];
  let targetIndex = -1;
  const searchDeadline = Date.now() + BASIC_INFO_SEARCH_TIMEOUT_MS;
  while (Date.now() < searchDeadline) {
    const snapshot = await readLocatorSnapshot(options);
    collectedSnapshot = snapshot;
    collected = snapshot.map((option) => ({
      value: option.value || option.id,
      label: option.text.replace(/\s+/g, " ").trim(),
    }));
    targetIndex = findButlerOptionIndex(collected, { contactCardId, displayName });
    if (targetIndex >= 0) break;
    await delay(150);
  }
  if (targetIndex < 0) {
    const texts = collected.map((option) => option.label);
    const who = displayName ? `「${displayName}」(ID ${contactCardId})` : `ID ${contactCardId}`;
    const detail = `管家联系人${who}不在 VBK 联系人下拉中（缺少 ID / 姓名精确匹配项）；请在 VBK 维护该联系人或更新账号固定信息后再重试。可选：${texts.filter(Boolean).join("、") || "无"}`;
    throw new Error(detail);
  }
  const clicked = await clickLocatorSnapshotOption(options, collectedSnapshot[targetIndex]);
  if (!clicked) throw new Error("管家联系人候选在提交前已被页面刷新，请重试。");
  await delay(300);
}
