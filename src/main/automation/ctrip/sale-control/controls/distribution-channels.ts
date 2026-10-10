/**
 * 「分销渠道」批量勾选：
 *   - 遍历所有 .ant-checkbox-wrapper；
 *   - 跳过「途风」和「泛定制-C」类定制渠道；
 *   - 跳过 disabled 和已勾选项；
 *   - 点完一次后回读状态，不成功时调用 dismissCustomizationModal 关闭可能弹出的
 *     泛定制弹层。
 *   - 返回 picked / skippedDisabled / skippedAlreadyChecked / skippedCustomization /
 *     skippedExcluded / total 给上层。
 *
 * 点击渠道后 VBK 会重渲染 checkbox group，原来的 nth(index) 可能失效；
 * 用渠道文本重新定位，避免最后一项被重排/隐藏后等待不存在的索引。
 */

import { delay } from "../../utils.js";
import { dismissCustomizationModal } from "../../dialogs.js";
import type { VbkPage } from "../../locator-types.js";
import { findRowByTitle } from "./row-locator.js";

export const DISTRIBUTION_CHANNELS_TO_SKIP = new Set(["途风"]);

export function shouldSkipDistributionChannel(label: string): boolean {
  return DISTRIBUTION_CHANNELS_TO_SKIP.has(label) || /^泛定制-C$/.test(label);
}

export async function checkAllEnabledDistributionChannels(page: VbkPage) {
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
  const skippedCustomization: string[] = [];
  const skippedExcluded: string[] = [];
  for (let index = 0; index < total; index += 1) {
    const label = labels[index] || "";
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
        || ((el.querySelector(".ant-checkbox-input") as HTMLInputElement | null)?.checked === true),
    ).catch(() => false);
    if (isChecked) {
      skippedAlreadyChecked += 1;
      continue;
    }

    await wrapper.evaluate((el) => (el as HTMLElement).click());
    await delay(120);
    const reopened = await wrapper.evaluate(
      (el) => el.classList.contains("ant-checkbox-wrapper-checked")
        || !!el.querySelector(".ant-checkbox-checked")
        || ((el.querySelector(".ant-checkbox-input") as HTMLInputElement | null)?.checked === true),
    ).catch(() => false);

    if (reopened) {
      picked += 1;
    } else {
      await dismissCustomizationModal(page);
    }
  }

  return { picked, skippedDisabled, skippedAlreadyChecked, skippedCustomization, skippedExcluded, total };
}