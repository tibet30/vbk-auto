
// @ts-nocheck
async function saveThenAdvance(page, options) {
  const {
    phase,
    targetTabLabel,
    saveButtonNames,
    targetTabLabels,
    isTargetUrl,
    nextButtonLabel = "下一步",
    savedWith,
    fallbackUrl,
  } = options;
  void fallbackUrl;

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
  await button.click();

  await dismissKnownNoticeDialogs(page, { waitForSaveSuccess: true });

  const deadline = Date.now() + 15_000;
  let navigated = false;
  let activeLabel: string | null = null;
  let unlockedLabel: string | null = null;
  let observedUrl = page.url();
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

  if (navigated) return { advanced: true, mode: "navigated", savedWith: effectiveSavedWith };

  if (unlockedLabel) {
    await clickSection(page, unlockedLabel);
    return { advanced: true, mode: "tabUnlocked", savedWith: effectiveSavedWith };
  }

  if (fallbackUrl) {
    console.warn(
      `${phase}的「${targetTabLabel}」未解锁，使用 fallbackUrl=${fallbackUrl} 直接导航`,
    );
    await page.goto(fallbackUrl, { waitUntil: "domcontentloaded" }).catch(() => false);
    await delay(1500);
    if (page.url() === fallbackUrl || isTargetUrl(page.url())) {
      return { advanced: true, mode: "fallback-url", savedWith: effectiveSavedWith };
    }
  }

  throw new Error(
    `${phase}点击「${nextButtonLabel}」后未到达目标「${targetTabLabel}」：URL=${observedUrl}，目标 tab 仍未解锁。`,
  );
}

async function findUnlockedSectionLabel(page, labels) {
  const candidates = Array.isArray(labels) ? labels : [labels];
  for (const label of candidates) {
    const tab = page.getByRole("tab", { name: label, exact: true });
    const tabCount = await tab.count();
    for (let index = 0; index < tabCount; index += 1) {
      const current = tab.nth(index);
      if (!(await current.isVisible())) continue;
      if ((await current.getAttribute("aria-disabled")) === "true") continue;
      return label;
    }
  }
  return null;
}



// @ts-nocheck
// Tab / Section 导航：负责点击 tab、安全保存、save-then-advance 状态机。
// 这些 helpers 在多个 phase 模块之间共享，是"录入流程"的核心跳转原语。

import { delay, pollUntil, safeClick } from "./utils.js";
import { closeBlockingDialogs, dismissKnownNoticeDialogs } from "./dialogs.js";
import { productEditorUrl } from "../constants.js";

async function clickSection(page, labels) {
  const candidates = Array.isArray(labels) ? labels : [labels];
  let disabledLabel = "";
  const url = page.url();
  if (/packageManage|priceInventory|newResourceRule/.test(url)) {
    return;
  }
  for (const label of candidates) {
    // 新版 VBK 使用顶层 tab（产品信息 / 产品图文），优先按角色定位，避免
    // 同名标题或帮助文案抢占点击。旧页面再回退到精确文本。
    const tab = page.getByRole("tab", { name: label, exact: true });
    const tabCount = await tab.count();
    for (let index = 0; index < tabCount; index += 1) {
      const current = tab.nth(index);
      if (!(await current.isVisible())) continue;
      if ((await current.getAttribute("aria-disabled")) === "true") {
        disabledLabel = label;
        continue;
      }
      const selected = (await current.getAttribute("aria-selected")) === "true";
      const className = (await current.getAttribute("class")) || "";
      if (selected || /\bant-tabs-tab-active\b/.test(className)) return;
      await current.click();
      await pollUntil(
        current,
        (loc) => loc.getAttribute("aria-selected").then((v) => v === "true"),
        3_000,
      );
      return;
    }

    const target = page.getByText(label, { exact: true });
    const count = await target.count();
    for (let index = 0; index < count; index += 1) {
      const current = target.nth(index);
      if (!(await current.isVisible())) continue;
      const disabledAncestor = current.locator(
        'xpath=ancestor-or-self::*[@aria-disabled="true" or contains(@class,"ant-tabs-tab-disabled")][1]',
      );
      if (await disabledAncestor.count()) {
        disabledLabel = label;
        continue;
      }
      await current.click();
      await delay(500);
      return;
    }
  }
  if (disabledLabel) {
    throw new Error(`"${disabledLabel}"入口尚未解锁，请先完成产品信息录入。`);
  }
  throw new Error(`找不到"${candidates.join(" / ")}"入口`);
}

async function waitForSectionEnabled(page, labels, timeout = 15_000) {
  const candidates = Array.isArray(labels) ? labels : [labels];
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const label of candidates) {
      const tab = page.getByRole("tab", { name: label, exact: true });
      const count = await tab.count();
      for (let index = 0; index < count; index += 1) {
        const current = tab.nth(index);
        if (
          (await current.isVisible()) &&
          (await current.getAttribute("aria-disabled")) !== "true"
        ) {
          return label;
        }
      }
    }
    await delay(250);
  }
  throw new Error(`产品信息保存后仍未解锁"${candidates.join(" / ")}"，已停止后续录入。`);
}

async function clickSafeSave(page, names) {
  for (const name of names) {
    const button = page.getByRole("button", { name, exact: true });
    let target = null;
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

async function submitCurrentSectionAndNext(page) {
  const label = "提交审核并下一步";
  const button = page.getByRole("button", { name: label, exact: true });
  await assertCount(button, 1, `${label}按钮`);
  if (!(await button.isVisible())) throw new Error(`${label}按钮当前不可见`);
  await button.click();
  await delay(1_000);
  return { action: label };
}

async function findActiveTabLabel(page, labels, timeoutMs = 0) {
  const candidates = Array.isArray(labels) ? labels : [labels];
  const probe = async () => {
    for (const label of candidates) {
      const tab = page.getByRole("tab", { name: label, exact: true });
      const tabCount = await tab.count();
      for (let index = 0; index < tabCount; index += 1) {
        const current = tab.nth(index);
        if (!(await current.isVisible())) continue;
        if ((await current.getAttribute("aria-selected")) === "true") return label;
        const cls = (await current.getAttribute("class")) || "";
        if (/\bant-tabs-tab-active\b/.test(cls)) return label;
      }
    }
    return null;
  };
  if (timeoutMs <= 0) return probe();
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await delay(150);
  }
  return last;
}


// 真实 VBK 跳转目标 URL 形如：
//   https://vbooking.ctrip.com/ivbk/vendor/productImageText?productId=...
// 路径段是 productImageText（不一定带尾斜杠），用「前后为 /、?、&
// 之一」做片段级判断，避免误命中 `vendor/productImageTextList` 这类无关
// 子路径，也避免误命中查询串里的 productImageText 关键字。
const PRODUCT_IMAGE_TEXT_REGEX = /(^|[/?&])productImageText([/?&]|$)/;

export function isProductImageTextUrl(url) {
  if (typeof url !== "string" || !url) return false;
  return PRODUCT_IMAGE_TEXT_REGEX.test(url);
}

// forward declaration，避免循环依赖
declare function assertCount(locator: any, expected: number, description: string): Promise<any>;

/**
 * 通用 save-then-advance helper（窄修复版）：
 * 状态机严格按以下顺序判定「保存后是否已真正进入目标页」：
 *   1) 先用约定的安全保存按钮保存，吃掉「保存成功」弹窗；
 *   2) URL 已落点（isTargetUrl）→ auto-navigated；
 *   3) 目标 tab 已 active → auto-navigated；
 *   4) 以上都不命中 → 点精确「下一步」按钮；
 *   5) 点击下一步后等待门禁：URL 落点 / 目标 tab active → navigated；
 *      仅目标 tab 解锁但未激活 → 安全 clickSection 落点 → tabUnlocked；
 *      都不命中 → 抛错。
 */

async function openProductEditor(page, productId, options = {}) {
  const { stayOnCurrentTab = false } = options;
  const targetUrl = productEditorUrl(productId);
  const current = page.url();
  const sameProduct = current.includes(encodeURIComponent(productId)) || current.includes(productId);
  const onEditorPath = /\/ivbk\/vendor\//.test(current) || /\/product\/input\//.test(current);
  if (sameProduct && onEditorPath) {
    if (stayOnCurrentTab) {
      return;
    }
    await ensureBasicInfoTabVisible(page);
    return;
  }
  await page.evaluate((url) => { window.location.href = url; }, targetUrl);
  await page.waitForURL(
    (url) => typeof url === "string" && (url.includes("baseInfoMerge") || /\/ivbk\/vendor\/tourdays\?/.test(url)),
    { timeout: 30_000 },
  ).catch(() => {});
  await page.getByText("基本信息", { exact: true }).first().waitFor({ timeout: 30_000 });
}

async function ensureBasicInfoTabVisible(page) {
  const visible = await page.getByText("基本信息", { exact: true }).first().isVisible().catch(() => false);
  if (visible) return;
  for (const label of ["基本信息", "产品信息"]) {
    const tab = page.getByRole("tab", { name: label, exact: true });
    if (await tab.count()) {
      await tab.first().click().catch(() => {});
      await page.getByText("基本信息", { exact: true }).first().waitFor({ timeout: 15_000 }).catch(() => {});
      return;
    }
  }
}

export {
  PRODUCT_IMAGE_TEXT_REGEX,
  clickSafeSave,
  clickSection,
  ensureBasicInfoTabVisible,
  findActiveTabLabel,
  findUnlockedSectionLabel,
  openProductEditor,
  saveThenAdvance,
  submitCurrentSectionAndNext,
  waitForSectionEnabled,
};
