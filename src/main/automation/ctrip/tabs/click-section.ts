/**
 * Tab / Section 导航原语：
 *   - clickSection：点击 section / tab（按 role=tab 优先，回退到精确文本）；
 *   - waitForSectionEnabled：轮询等下一个 tab 可见且 aria-disabled != "true"。
 *
 * 两个函数被 saveThenAdvance（save-then-advance.ts）和 basic-info 录入流程
 * 共用，作为跨阶段 tab 跳转的基本动词。
 */

import { delay, pollUntil } from "../utils.js";
import { closeBlockingDialogs } from "../dialogs.js";
import { logWarn } from "../../../../shared/log-timestamp.js";
import type { VbkLocator, VbkPage } from "../locator-types.js";

/**
 * 点击 section / tab，优先按 role=tab 定位（新版 VBK 顶层 tab），再回退到精确文本；
 *   - 命中已 selected / ant-tabs-tab-active 时直接 return；
 *   - 命中 disabled / aria-disabled 时记下 disabledLabel，最后统一抛错；
 *   - URL 含 packageManage / priceInventory / newResourceRule 时直接 return（不重复导航）。
 */
async function clickSection(page: VbkPage, labels: string | string[]): Promise<void> {
  const candidates = Array.isArray(labels) ? labels : [labels];
  let disabledLabel = "";
  const url = page.url();
  if (/packageManage|priceInventory|newResourceRule/.test(url)) {
    return;
  }
  for (const label of candidates) {
    const roleTabResult = await page.evaluate((expected) => {
      const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
      const tab = tabs.find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return (candidate.textContent || "").trim() === expected && rect.width > 0 && rect.height > 0;
      });
      if (!tab) return "missing";
      if (tab.getAttribute("aria-disabled") === "true") return "disabled";
      if (tab.getAttribute("aria-selected") === "true" || tab.classList.contains("ant-tabs-tab-active")) return "selected";
      (tab as HTMLElement).click();
      return "clicked";
    }, label).catch(() => "missing");
    if (roleTabResult === "selected" || roleTabResult === "clicked") {
      if (roleTabResult === "clicked") await delay(500);
      return;
    }
    if (roleTabResult === "disabled") {
      disabledLabel = label;
      continue;
    }
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
      // Electron WebContentsView 中可能已有一个 Playwright 判定为“未结束”的
      // 历史导航；即使 noWaitAfter=true，locator.click 也会先等旧导航并超时。
      // 在页面上下文触发原生 click，页签落点仍由下面 aria-selected 轮询确认。
      if (typeof current.evaluate === "function") {
        await current.evaluate((element) => (element as HTMLElement).click());
      } else {
        // 松散测试替身兼容；真实 Playwright Locator 始终有 evaluate。
        await current.click({ noWaitAfter: true });
      }
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
      if (typeof current.evaluate === "function") {
        await current.evaluate((element) => (element as HTMLElement).click());
      } else {
        await current.click({ noWaitAfter: true });
      }
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
async function waitForSectionEnabled(
  page: VbkPage,
  labels: string | string[],
  timeout = 15_000,
): Promise<string> {
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

export {
  clickSection,
  waitForSectionEnabled,
};
