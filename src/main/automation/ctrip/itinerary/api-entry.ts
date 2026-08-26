/**
 * itinerary 阶段「全量接口保存」主入口：fillItineraryDraftApi。
 *
 * 设计目标：彻底替换原 fillItineraryDraft 的 DOM 写入路径，
 *   - 第一步：调 ensureItineraryApi 走 soa2 全量接口（getTourInfo →
 *     getTourDailyDetail → suggestAirport / suggestTrainStation →
 *     transformItinerary → checkTourDaily(saveType=8) →
 *     calculateTourInfoScore → checkTourDaily(saveType=3) →
 *     saveTourDailyDetail → saveProductTourInfo → getTourDailyDetail
 *     回读校验）。任何一步 Ack=Failure / 字段缺失 / 回读不一致都会抛错；
 *   - 第二步：DOM 仅用于导航 — 跳到产品编辑器、点「存为草稿」、
 *     走 saveThenAdvance 等到 packageManage URL 落点（验证「提交审核
 *     并下一步」真正进入了套餐管理页）；
 *   - 第三步：返回结构化结果供 audit / 落库 / 下游 phase 接力。
 *
 * 与 fillItineraryDraft（DOM 版）的差异：
 *   - 不再按 day 填 title textarea / 包车 / 接送站 / 餐食 / 酒店卡片；
 *   - 不再调 stations DOM helper（fillPickupAndDropoff / handleAirportTrainModal）；
 *   - 不再用 cards DOM helper（fillHotelCard / fillMealCards）；
 *   - 行程数据完全由 itinerary-transform.ts 生成 VBK 协议 payload 走接口写入。
 */

import type { Page } from "playwright";
import { delay, pollUntil } from "../utils.js";
import { saveThenAdvance } from "../tabs.js";
import { productSectionUrl } from "../../constants.js";
import { ensureItineraryApi } from "../itinerary-api.js";
import type { ProductItineraryDay, ProductOperations } from "../itinerary-api/itinerary-transform.js";
import { isPackageManageUrl } from "./main.js";

export interface FillItineraryDraftApiOptions {
  disambiguator?: unknown;
  productId?: string | number;
}

export interface FillItineraryDraftApiResult {
  savedWith: string;
  days: number;
  apiResult: unknown;
  submitResult: unknown;
}

export interface ItineraryDraftProduct {
  itinerary?: ProductItineraryDay[];
  operations?: ProductOperations;
  productId?: string | number;
}

function isItineraryUrlForProduct(rawUrl: string, productId: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.origin === "https://vbooking.ctrip.com"
      && url.pathname.replace(/\/+$/, "") === "/ivbk/vendor/tourdays"
      && String(url.searchParams.get("productid") ?? url.searchParams.get("productId") ?? "") === productId;
  } catch {
    return false;
  }
}

async function clickHydrationTab(page: Page, label: string): Promise<void> {
  const clicked = await page.evaluate((targetLabel) => {
    const tabs = Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]'));
    const target = tabs.find((tab) => {
      const visible = Boolean(tab.offsetWidth || tab.offsetHeight || tab.getClientRects().length);
      return visible
        && tab.getAttribute("aria-disabled") !== "true"
        && (tab.textContent ?? "").trim() === targetLabel;
    });
    if (!target) return false;
    target.click();
    return true;
  }, label);
  // 自由行的真实页面把行程编辑器渲染在“产品图文”页签下，内容标题为
  // “行程A”，不额外提供名为“行程描述”的 role=tab；标题输入框本身就是
  // 更可靠的水合证据，避免把合法页面误判为导航失败。
  if (!clicked && label === "行程描述") {
    const hasItineraryEditor = await page.locator('textarea[placeholder^="请输入标题"]').count().then((n) => n > 0).catch(() => false);
    if (hasItineraryEditor) return;
  }
  if (!clicked) throw new Error(`接口保存后找不到可点击的“${label}”页签，无法重新水合行程。`);
}

async function waitForHydratedItineraryDom(page: Page): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const ready = await page.evaluate(() => {
      const visible = (element: Element): boolean => {
        const html = element as HTMLElement;
        return Boolean(html.offsetWidth || html.offsetHeight || html.getClientRects().length);
      };
      const activeItinerary = Array.from(document.querySelectorAll('[role="tab"]')).some((tab) =>
        visible(tab)
        && (tab.textContent ?? "").trim() === "行程描述"
        && (tab.getAttribute("aria-selected") === "true"
          || tab.classList.contains("ant-tabs-tab-active")));
      const inlineItineraryEditor = document.querySelectorAll('textarea[placeholder^="请输入标题"]').length > 0;
      const submitVisible = Array.from(document.querySelectorAll("button")).some((button) =>
        visible(button) && /提交审核/.test((button.textContent ?? "").trim()));
      return (activeItinerary || inlineItineraryEditor) && submitVisible;
    }).catch(() => false);
    if (ready) return;
    await delay(250);
  }
  throw new Error("接口保存后行程页未在 60000ms 内完成水合：行程页签或提交审核按钮不可见。");
}

/**
 * 图文「下一步」可能仍在做一次晚到导航，与接口保存后的 tourdays 重载相撞，
 * Playwright 会把本次 goto 标成 ERR_ABORTED。只吸收这一种可重试竞态；其它
 * 网络/证书/登录错误保持原样上抛。最终成功 goto 用于从后端重新水合接口数据。
 */
export async function navigateToHydratedItinerary(
  page: Page,
  productId: string,
  options: { attempts?: number; retryDelayMs?: number } = {},
): Promise<void> {
  const attempts = options.attempts ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 750;
  const targetUrl = productSectionUrl(productId, "itinerary");
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);
    try {
      if (isItineraryUrlForProduct(page.url(), productId)) {
        // Electron WebContentsView 对同页 reload 以及普通 locator.click 都会
        // 出现 Playwright 永远等待 navigation finished 的假死，即使页签已经
        // 实际切换。改用页面内原生 click 做「产品图文 → 行程描述」往返，并只
        // 以真实 active 页签 + 可见提交按钮作为水合证据。DOM 仅负责导航。
        await clickHydrationTab(page, "产品图文");
        await delay(1_000);
        await clickHydrationTab(page, "行程描述");
        await waitForHydratedItineraryDom(page);
      } else {
        await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
      }
      return;
    } catch (error) {
      lastError = error;
      if (!/ERR_ABORTED/i.test(error instanceof Error ? error.message : String(error)) || attempt === attempts) {
        throw error;
      }
      await delay(retryDelayMs);
    }
  }
  throw lastError;
}

/**
 * 行程阶段全量接口保存主入口。
 */
export async function fillItineraryDraftApi(
  page: Page,
  product: ItineraryDraftProduct,
  options: FillItineraryDraftApiOptions = {},
): Promise<FillItineraryDraftApiResult> {
  const productId = String(options?.productId || product?.productId || "");
  if (!productId) {
    throw new Error("行程阶段全量接口保存：产品 ID 缺失，无法继续。");
  }
  if (!Array.isArray(product?.itinerary) || product.itinerary.length === 0) {
    throw new Error("行程阶段全量接口保存：行程数组为空，无法继续。");
  }

  // 1) 全量接口保存 + 回读校验（任何字段缺失或 Ack=Failure 都会抛错）。
  //    这里不做 DOM 导航；会话请求直接在已登录页面上下文执行。
  const apiResult = await ensureItineraryApi(page, {
    itinerary: product.itinerary,
    operations: product.operations,
    productId: product.productId,
  }, productId);
  if (!apiResult?.tourInfoId) {
    throw new Error("行程阶段全量接口保存：ensureItineraryApi 未返回合法 tourInfoId。");
  }

  // 2) DOM 只负责提交审核和导航。接口保存期间页面仍可能保留旧表单状态，
  //    因此必须重新进入 tourdays，让页面从后端加载刚刚回读通过的数据。
  //    不再点击「存为草稿」：旧页面状态再次保存会覆盖接口写入结果。
  await navigateToHydratedItinerary(page, productId);
  await waitForHydratedItineraryDom(page);
  const savedWith = "itinerary-api";
  const submitResult = await saveThenAdvance(page, {
    phase: "ItineraryDraft",
    targetTabLabel: "套餐管理",
    saveButtonNames: [],
    targetTabLabels: ["套餐管理"],
    isTargetUrl: isPackageManageUrl,
    nextButtonLabel: "提交审核并下一步",
    advanceTimeoutMs: 120_000,
    savedWith,
  });
  if (!submitResult?.advanced) {
    throw new Error("ItineraryDraft 未提交通过：未进入下一阶段");
  }

  // 3) 等「套餐管理」URL 真正落定（saveThenAdvance 已探测一次，这里再确认）
  const probe = { url: () => page.url() };
  await pollUntil(
    probe,
    (p: { url: () => string }) => Promise.resolve(isPackageManageUrl(p.url())),
    5_000,
  ).catch(() => undefined);
  if (!isPackageManageUrl(page.url())) {
    throw new Error(`行程提交后 URL 未落定到套餐管理：${page.url()}`);
  }
  await delay(1_000);
  return {
    savedWith,
    days: product.itinerary.length,
    apiResult,
    submitResult,
  };
}
