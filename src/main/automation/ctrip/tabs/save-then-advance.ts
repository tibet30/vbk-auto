/**
 * 「保存 → 进入目标 tab」状态机（窄修复版），配套 findActiveTabLabel /
 * findUnlockedSectionLabel 探测：
 *   1) 调 clickSafeSave 保存并吃「保存成功」弹窗；
 *   2) 若 URL 已落点 / 目标 tab 已 active → auto-navigated；
 *   3) 否则精确点「下一步」按钮，等待 URL / tab 落点 → navigated；
 *   4) 仅目标 tab 解锁 → clickSection 落点 → tabUnlocked；
 *   5) 下一步按钮已缺失 (count===0) 且目标 tab 已解锁 → clickSection 落点
 *      → tabAlreadyUnlocked（真实幂等：行程已提交/产品已存盘时按钮被替换）；
 *   6) 都不命中 → 若有 fallbackUrl 则直接导航；再不行就抛错。
 *   注：count > 0 时仍按原路径走按钮点击，绝不能提前跳过。
 *
 * 严格保持 `saveThenAdvance` 紧邻 `findUnlockedSectionLabel` 的源码顺序，
 * 是 basic-info-fixes 的 indexOf 切片断言依赖。
 */

import { delay } from "../utils.js";
import { dismissKnownNoticeDialogs } from "../dialogs.js";
import { formatValidationErrors, inspectAndRepairValidationErrors } from "../save-validation.js";
import { logWarn } from "../../../../shared/log-timestamp.js";
import type { VbkPage } from "../locator-types.js";
import { clickSafeSave } from "./click-safe-save.js";
import { clickSection } from "./click-section.js";

interface SaveThenAdvanceOptions {
  phase: string;
  targetTabLabel: string;
  saveButtonNames: string[];
  targetTabLabels: string[];
  isTargetUrl: (url: string) => boolean;
  nextButtonLabel?: string;
  savedWith?: string;
  fallbackUrl?: string;
  advanceTimeoutMs?: number;
}

async function saveThenAdvance(page: VbkPage, options: SaveThenAdvanceOptions) {
  const {
    phase,
    targetTabLabel,
    saveButtonNames,
    targetTabLabels,
    isTargetUrl,
    nextButtonLabel = "下一步",
    savedWith,
    fallbackUrl,
    advanceTimeoutMs = 30_000,
  } = options;
  void fallbackUrl;

  // 必须先 dismissKnownNoticeDialogs 吃掉线路变更提示等白名单弹窗，否则其遮罩会拦下后续 click。
  await dismissKnownNoticeDialogs(page);

  const effectiveSavedWith = savedWith ?? (await clickSafeSave(page, saveButtonNames));

  if (isTargetUrl(page.url())) {
    return { advanced: true, mode: "auto-navigated", savedWith: effectiveSavedWith };
  }

  const activeBeforeClick = await findActiveTabLabel(page, targetTabLabels, 3_000);
  if (activeBeforeClick) {
    return { advanced: true, mode: "auto-navigated", savedWith: effectiveSavedWith };
  }

  const buttons = page.getByRole("button", { name: nextButtonLabel, exact: true });
  const count = await buttons.count();
  if (count !== 1) {
    // 真实幂等场景：行程已提交后「下一步」按钮已不存在（VBK tourdays 页
    // 只剩「存为草稿 / 提交审核」），目标 tab 可能已解锁。先探测 unlocked：
    // 解锁则 clickSection 落点并返回 tabAlreadyUnlocked；锁定 / count>1
    // 仍抛原数量错误。count === 1 时由下方正常按钮点击路径接管，绝不
    // 在按钮仍存在时提前跳过点击。
    if (count === 0) {
      const unlockedLabel = await findUnlockedSectionLabel(page, targetTabLabels);
      if (unlockedLabel) {
        await clickSection(page, unlockedLabel);
        return { advanced: true, mode: "tabAlreadyUnlocked", savedWith: effectiveSavedWith };
      }
    }
    throw new Error(
      `${phase}的「${nextButtonLabel}」按钮数量异常：期望 1，实际 ${count}；观测 URL=${page.url()}；目标 tab=${targetTabLabel}。`,
    );
  }
  const button = buttons.first();
  if (!(await button.isVisible())) {
    throw new Error(
      `${phase}的「${nextButtonLabel}」按钮当前不可见，无法提交；观测 URL=${page.url()}；目标 tab=${targetTabLabel}。`,
    );
  }
  if (!((await button.isEnabled()) ?? true)) {
    throw new Error(
      `${phase}的「${nextButtonLabel}」按钮处于 disabled 状态，无法提交；观测 URL=${page.url()}；目标 tab=${targetTabLabel}。`,
    );
  }
  if ((await button.getAttribute("aria-disabled")) === "true") {
    throw new Error(
      `${phase}的「${nextButtonLabel}」按钮 aria-disabled=true，无法提交；观测 URL=${page.url()}；目标 tab=${targetTabLabel}。`,
    );
  }
  let observedUrl = page.url();
  let validationSummary = "";
  for (let submitAttempt = 1; submitAttempt <= 2; submitAttempt += 1) {
    // 保存/下一步之后新冒出来的线路变更提示，再清一次。关闭提示不等于推进成功。
    await button.click();

    await dismissKnownNoticeDialogs(page, { waitForSaveSuccess: true });

    // VBK 保存成功后可能先返回保存响应，再异步跳转到下一页；15 秒会把
    // 已发生的晚到导航误判为失败。给目标 URL / active tab 留出 30 秒观测窗口。
    const deadline = Date.now() + advanceTimeoutMs;
    let navigated = false;
    let activeLabel: string | null = null;
    let unlockedLabel: string | null = null;
    while (Date.now() < deadline) {
      const url = page.url();
      observedUrl = url;
      if (isTargetUrl(url)) {
        navigated = true;
        break;
      }
      activeLabel = await findActiveTabLabel(page, targetTabLabels);
      if (activeLabel) {
        navigated = true;
        break;
      }
      unlockedLabel = await findUnlockedSectionLabel(page, targetTabLabels);
      if (unlockedLabel) break;
      await delay(250);
    }

    if (navigated) {
      if (submitAttempt === 1) {
        return { advanced: true, mode: "navigated", savedWith: effectiveSavedWith };
      }
      return { advanced: true, mode: "repaired-navigated", savedWith: effectiveSavedWith };
    }

    if (unlockedLabel) {
      await clickSection(page, unlockedLabel);
      if (submitAttempt === 1) {
        return { advanced: true, mode: "tabUnlocked", savedWith: effectiveSavedWith };
      }
      return { advanced: true, mode: "repaired-tabUnlocked", savedWith: effectiveSavedWith };
    }

    const validation = await inspectAndRepairValidationErrors(page);
    validationSummary = formatValidationErrors(validation.after?.length ? validation.after : validation.errors);
    if (submitAttempt === 1) {
      logWarn(validation.repaired
        ? `${phase}点击「${nextButtonLabel}」后未推进，已自动修复页面校验错误：${validation.repairs.join("；")}`
        : `${phase}点击「${nextButtonLabel}」后暂未推进，执行一次同页重试`,
      );
      continue;
    }
    break;
  }

  if (fallbackUrl) {
    logWarn(
      `${phase}的「${targetTabLabel}」未解锁，使用 fallbackUrl=${fallbackUrl} 直接导航`,
    );
    await page.goto(fallbackUrl, { waitUntil: "domcontentloaded" }).catch(() => false);
    await delay(1500);
    if (page.url() === fallbackUrl || isTargetUrl(page.url())) {
      return { advanced: true, mode: "fallback-url", savedWith: effectiveSavedWith };
    }
  }

  throw new Error(
    `${phase}点击「${nextButtonLabel}」后未到达目标「${targetTabLabel}」：URL=${observedUrl}，目标 tab 仍未解锁。` +
      (validationSummary ? ` 页面校验错误：${validationSummary}` : ""),
  );
}

/**
 * 在候选 label 中找第一个 tab：可见且 aria-disabled != "true"。命中返回 label，否则 null。
 * 用于 saveThenAdvance 探测目标 tab 是否已经被前序保存解锁。
 */
async function findUnlockedSectionLabel(
  page: VbkPage,
  labels: string | string[],
): Promise<string | null> {
  const candidates = Array.isArray(labels) ? labels : [labels];
  return page.evaluate((expected) => {
    const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
    for (const label of expected) {
      const matched = tabs.find((tab) => {
        const rect = tab.getBoundingClientRect();
        return (tab.textContent || "").trim() === label
          && rect.width > 0
          && rect.height > 0
          && tab.getAttribute("aria-disabled") !== "true";
      });
      if (matched) return label;
    }
    return null;
  }, candidates).catch(() => null);
}

/**
 * 探测候选 label 当前是否有「active」tab（aria-selected=true 或 class 含 ant-tabs-tab-active）：
 *   - timeoutMs = 0 立即返回；
 *   - timeoutMs > 0 轮询 150ms 直到命中或超时。
 */
async function findActiveTabLabel(
  page: VbkPage,
  labels: string | string[],
  timeoutMs = 0,
): Promise<string | null> {
  const candidates = Array.isArray(labels) ? labels : [labels];
  // locator.count/evaluate 会在 VBK 的晚到导航期间等待 navigation finished，
  // 即使目标页 DOM 已经可用也可能整整卡满默认 30 秒。页面内只读探针不
  // 绑定导航生命周期，适合这里的瞬时状态判断。
  const probe = async () => page.evaluate((expected) => {
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
    for (const label of expected) {
      const matched = tabs.find((tab) => (tab.textContent || "").trim() === label && visible(tab));
      if (!matched) continue;
      if (matched.getAttribute("aria-selected") === "true" || matched.classList.contains("ant-tabs-tab-active")) return label;
    }
    return null;
  }, candidates).catch(() => null);
  if (timeoutMs <= 0) return probe();
  const deadline = Date.now() + timeoutMs;
  let last: string | null = null;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await delay(150);
  }
  return last;
}

export {
  saveThenAdvance,
  findUnlockedSectionLabel,
  findActiveTabLabel,
};
