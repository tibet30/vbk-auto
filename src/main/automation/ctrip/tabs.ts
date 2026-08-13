
/**
 * Tab / Section 导航 + 安全保存 + save-then-advance 状态机：跨 phase 复用
 * 的跳转/保存原语（clickSection / clickSafeSave / waitForSectionEnabled /
 * findUnlockedSectionLabel / findActiveTabLabel）；saveThenAdvance 是「保存
 * → URL 落点 / tab 自动激活 / 下一步按钮 / 按钮缺失但 tab 已解锁 / 兜底
 * fallbackUrl」窄修复状态机；openProductEditor / ensureBasicInfoTabVisible
 * 负责跨产品入口跳转与基本 tab 定位。
 */

// @ts-nocheck

/**
 * 「保存 → 进入目标 tab」状态机（窄修复版）：
 *   1) 调 clickSafeSave 保存并吃「保存成功」弹窗；
 *   2) 若 URL 已落点 / 目标 tab 已 active → auto-navigated；
 *   3) 否则精确点「下一步」按钮，等待 URL / tab 落点 → navigated；
 *   4) 仅目标 tab 解锁 → clickSection 落点 → tabUnlocked；
 *   5) 下一步按钮已缺失 (count===0) 且目标 tab 已解锁 → clickSection 落点
 *      → tabAlreadyUnlocked（真实幂等：行程已提交/产品已存盘时按钮被替换）；
 *   6) 都不命中 → 若有 fallbackUrl 则直接导航；再不行就抛错。
 *   注：count > 0 时仍按原路径走按钮点击，绝不能提前跳过。
 */
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
  // 保存/下一步之后新冒出来的线路变更提示，再清一次。关闭提示不等于推进成功。
  await button.click();

  await dismissKnownNoticeDialogs(page, { waitForSaveSuccess: true });

  // VBK 保存成功后可能先返回保存响应，再异步跳转到下一页；15 秒会把
  // 已发生的晚到导航误判为失败。给目标 URL / active tab 留出 30 秒观测窗口。
  const deadline = Date.now() + 30_000;
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
    `${phase}点击「${nextButtonLabel}」后未到达目标「${targetTabLabel}」：URL=${observedUrl}，目标 tab 仍未解锁。`,
  );
}

/**
 * 在候选 label 中找第一个 tab：可见且 aria-disabled != "true"。命中返回 label，否则 null。
 * 用于 saveThenAdvance 探测目标 tab 是否已经被前序保存解锁。
 */
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
import { logWarn } from "../../../shared/log-timestamp.js";

/**
 * 点击 section / tab，优先按 role=tab 定位（新版 VBK 顶层 tab），再回退到精确文本；
 *   - 命中已 selected / ant-tabs-tab-active 时直接 return；
 *   - 命中 disabled / aria-disabled 时记下 disabledLabel，最后统一抛错；
 *   - URL 含 packageManage / priceInventory / newResourceRule 时直接 return（不重复导航）。
 */
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

/**
 * 轮询（间隔 250ms，最多 timeoutMs）直到候选 label 任一 tab 可见且 aria-disabled != "true"；
 * 超时抛错，常用于保存之后等下一个 tab 解锁。
 */
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

/**
 * 按顺序尝试 names 里的按钮名（如「保存」/「保存并下一步」）：
 *   - 先用 getByRole({ name, exact: true }) 精确定位；
 *   - 找不到再回退到「文本严格相等（去空白）」扫所有按钮；
 * 命中后点击 + 顺手 dismissKnownNoticeDialogs。找不到抛出。
 */
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

/**
 * 直接点「提交审核并下一步」按钮并 assert 唯一可见，用于部分 phase 末尾一次性提交。
 */
async function submitCurrentSectionAndNext(page) {
  const label = "提交审核并下一步";
  const button = page.getByRole("button", { name: label, exact: true });
  await assertCount(button, 1, `${label}按钮`);
  if (!(await button.isVisible())) throw new Error(`${label}按钮当前不可见`);
  await button.click();
  await delay(1_000);
  return { action: label };
}

/**
 * 探测候选 label 当前是否有「active」tab（aria-selected=true 或 class 含 ant-tabs-tab-active）：
 *   - timeoutMs = 0 立即返回；
 *   - timeoutMs > 0 轮询 150ms 直到命中或超时。
 */
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
 * 跳到 productEditorUrl 并等 baseInfoMerge / tourdays 路径之一落点：
 *   - 当前已经在这个产品路径上（且不在外层 URL）则不重复跳转，可选 stayOnCurrentTab；
 *   - 通过 window.location.href 在浏览器内导航（保留 CSP / 不走 goto 防误刷新）；
 *   - 落点后等「基本信息」文本出现，便于后续 phase 进一步操作。
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

/**
 * 「基本信息」tab 可见性兜底：若当前不可见则按 role=tab 试「基本信息」/「产品信息」点开。
 */
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
