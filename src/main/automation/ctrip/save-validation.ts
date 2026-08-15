// @ts-nocheck
/**
 * 保存/提交后页面校验错误采集与已知错误自动修复。
 *
 * VBK 有些表单不会在点击按钮时立刻跳转，而是在当前页把必填项标红。
 * 上层状态机在判定“未到达目标”前调用这里：先收集红错；已知可安全修复的
 * 错误先修，再让上层重提一次。
 */

import { delay } from "./utils.js";

const HOTEL_SOURCE_LABELS = ["使用携程平台酒店", "携程平台酒店"];

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

async function collectVisibleValidationErrors(page) {
  return page.evaluate(String.raw`(function () {
    function visible(element) {
      if (!(element instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }
    function normalize(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
    function labelOf(item) {
      const label = item.querySelector("label, .ant-form-item-label");
      if (label) return normalize(label.textContent).replace(/\s*\*\s*$/, "");
      const text = normalize(item.textContent);
      const error = item.querySelector(".ant-form-item-explain-error, .ant-form-explain, [role='alert']");
      const errorText = normalize(error ? error.textContent : "");
      return normalize(errorText ? text.replace(errorText, "") : text).slice(0, 80);
    }
    function textOf(node) { return normalize(node ? node.textContent : ""); }
    const nodes = Array.from(document.querySelectorAll([
      ".ant-form-item-has-error",
      ".has-error",
      ".ant-form-item-explain-error",
      ".ant-form-explain",
      "[role='alert']",
      "[aria-invalid='true']",
    ].join(",")));
    const byKey = new Map();
    for (const node of nodes) {
      if (!(node instanceof HTMLElement)) continue;
      if (!visible(node) && !node.closest(".ant-form-item-has-error,.has-error")) continue;
      const item = node.closest(".ant-form-item, .form-item, [class*='formItem']") || node;
      if (!(item instanceof HTMLElement) || !visible(item)) continue;
      const errorNode = item.querySelector(".ant-form-item-explain-error, .ant-form-explain, [role='alert']");
      const message = textOf(errorNode) || textOf(node);
      const label = labelOf(item);
      const key = label + "|" + message;
      if (!message && !label) continue;
      byKey.set(key, { label, message, text: textOf(item).slice(0, 200) });
    }
    return Array.from(byKey.values()).slice(0, 20);
  })()`);
}

async function isRadioOptionChecked(scope, optionLabel) {
  const matches = scope.getByText(optionLabel, { exact: true });
  for (let index = 0; index < (await matches.count()); index += 1) {
    const match = matches.nth(index);
    const wrapper = match.locator("xpath=ancestor-or-self::label[1]");
    if (!(await wrapper.count())) continue;
    const input = wrapper.first().locator('input[type="radio"]');
    if ((await input.count()) && (await input.first().isChecked().catch(() => false))) return true;
    const wrapperClass = (await wrapper.first().getAttribute("class").catch(() => "")) || "";
    const radioClass = (await wrapper.first().locator(".ant-radio").first().getAttribute("class").catch(() => "")) || "";
    if (/\bant-radio-wrapper-checked\b/.test(wrapperClass) || /\bant-radio-checked\b/.test(radioClass)) return true;
    if ((await wrapper.first().getAttribute("aria-checked").catch(() => "")) === "true") return true;
  }
  return false;
}

async function chooseRadioOption(scope, labels, description) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    for (const label of labels) {
      const text = scope.getByText(label, { exact: true });
      for (let index = 0; index < (await text.count()); index += 1) {
        const current = text.nth(index);
        if (!(await current.isVisible().catch(() => false))) continue;
        if (await isRadioOptionChecked(scope, label)) return label;
        const labelWrapper = current.locator("xpath=ancestor-or-self::label[1]");
        const clickable = (await labelWrapper.count()) ? labelWrapper.first() : current;
        await clickable.scrollIntoViewIfNeeded().catch(() => undefined);
        await clickable.click({ force: true }).catch(() => undefined);
        await delay(150);
        if (await isRadioOptionChecked(scope, label)) return label;
      }
    }
    if (attempt < 3) await delay(250 * attempt);
  }
  throw new Error(`${description}未能选中：${labels.join(" / ")}`);
}

async function repairHotelSource(page) {
  const formItems = page.locator(".ant-form-item, .form-item, [class*='formItem']").filter({ hasText: "酒店来源" });
  for (let index = 0; index < (await formItems.count()); index += 1) {
    const item = formItems.nth(index);
    if (!(await item.isVisible().catch(() => false))) continue;
    const selected = await chooseRadioOption(item, HOTEL_SOURCE_LABELS, "酒店来源");
    return { repaired: true, message: `已补选酒店来源：${selected}` };
  }
  return { repaired: false, message: "未找到酒店来源表单项" };
}

function needsHotelSourceRepair(errors) {
  return errors.some((entry) => /酒店来源/.test(`${entry.label} ${entry.text}`) && /请选择|required|必填/.test(`${entry.message} ${entry.text}`));
}

async function inspectAndRepairValidationErrors(page) {
  const before = await collectVisibleValidationErrors(page);
  const repairs = [];
  if (needsHotelSourceRepair(before)) {
    const result = await repairHotelSource(page);
    repairs.push(result.message);
    if (result.repaired) {
      await delay(300);
      return {
        errors: before,
        repaired: true,
        repairs,
        after: await collectVisibleValidationErrors(page),
      };
    }
  }
  return { errors: before, repaired: false, repairs, after: before };
}

function formatValidationErrors(errors) {
  const parts = errors
    .map((entry) => {
      const label = normalizeText(entry.label);
      const message = normalizeText(entry.message || entry.text);
      return label && message ? `${label}: ${message}` : (message || label);
    })
    .filter(Boolean);
  return Array.from(new Set(parts)).slice(0, 8).join("；");
}

export {
  collectVisibleValidationErrors,
  formatValidationErrors,
  inspectAndRepairValidationErrors,
};
