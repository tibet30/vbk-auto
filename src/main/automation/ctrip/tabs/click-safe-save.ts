/**
 * 「安全保存」+「提交审核并下一步」一键动作原语：
 *   - clickSafeSave(names)：按顺序尝试候选按钮名（精确 role 命中或文本严格相等），
 *     命中后点击 + 顺手 dismissKnownNoticeDialogs；
 *   - submitCurrentSectionAndNext：直接点「提交审核并下一步」按钮并断言唯一可见，
 *     用于部分 phase 末尾一次性提交。
 */

import { assertCount, delay } from "../utils.js";
import { dismissKnownNoticeDialogs } from "../dialogs.js";
import type { VbkLocator, VbkPage } from "../locator-types.js";

/**
 * 按顺序尝试 names 里的按钮名（如「保存」/「保存并下一步」）：
 *   - 先用 getByRole({ name, exact: true }) 精确定位；
 *   - 找不到再回退到「文本严格相等（去空白）」扫所有按钮；
 * 命中后点击 + 顺手 dismissKnownNoticeDialogs。找不到抛出。
 */
async function clickSafeSave(page: VbkPage, names: string[]): Promise<string> {
  for (const name of names) {
    const button = page.getByRole("button", { name, exact: true });
    let target: VbkLocator | null = null;
    if ((await button.count()) && (await button.first().isVisible())) {
      target = button.first();
    } else {
      const buttons = page.getByRole("button");
      for (let index = 0; index < (await buttons.count()); index += 1) {
        const current = buttons.nth(index);
        if (!(await current.isVisible().catch(() => false))) continue;
        const text = (await current.innerText().catch(() => "")).replace(/\s+/g, "");
        if (text === name.replace(/\s+/g, "")) {
          target = current;
          break;
        }
      }
    }
    if (target) {
      await target.click();
      await dismissKnownNoticeDialogs(page, { waitForSaveSuccess: true });
      return name;
    }
  }
  throw new Error(`找不到安全保存按钮：${names.join("、")}`);
}

/**
 * 直接点「提交审核并下一步」按钮并 assert 唯一可见，用于部分 phase 末尾一次性提交。
 */
async function submitCurrentSectionAndNext(page: VbkPage) {
  const label = "提交审核并下一步";
  const button = page.getByRole("button", { name: label, exact: true });
  await assertCount(button, 1, `${label}按钮`);
  if (!(await button.isVisible())) throw new Error(`${label}按钮当前不可见`);
  await button.click();
  await delay(1_000);
  return { action: label };
}

export {
  clickSafeSave,
  submitCurrentSectionAndNext,
};
