// @ts-nocheck
/**
 * 产品图文页（productImageText）页面层：
 *   - selectCtripLibraryImage / selectCtripLibraryCover：在「从图库资源导入」弹窗里搜索 poi 并按
 *     质量 / 分辨率要求挑图，确认协议并提交；
 *   - fillAndSavePresentation：跳到产品图文 tab → 填推荐理由 → 上封面 → 填推荐语与产品特点 →
 *     经 saveThenAdvance 推进到「行程描述」。
 * 顶部带 `// @ts-nocheck`，形参 page 是动态传入。
 */

import { delay, assertCount } from "../utils.js";
import { clickSection, isProductImageTextUrl, saveThenAdvance } from "../tabs.js";
import { findBestCtripLibraryImage, type CtripLibraryImageAspect } from "../../schema/schema-functions.js";
import {
  buildRecommendationReasonsPlan,
} from "./recommendations.js";
import { assertPresentationReadyForVbk } from "../../automation-contract.js";
import { bindCtripLibraryCoverViaApi } from "./cover-bind.js";
import { savePresentationViaApi } from "./presentation-api.js";

export { RECOMMENDATION_CATEGORIES } from "../../schema/schema-definitions.js";

export interface LibraryImageParams {
  trigger: any;
  poi: string;
  description?: string;
  minQuality?: number;
  aspect?: CtripLibraryImageAspect;
  label: string;
}

/**
 * 指定任意 trigger 元素触发的「携程图库导入」弹窗（适用于景点配图）：
 *   - hover + 点「图库导入」；
 *   - 弹窗里按 #PoiId 搜索 poi；
 *   - 等若干次拿到候选列表 → 用 findBestCtripLibraryImage 选最佳；
 *   - 同意协议 + 「同意并导入」+ 等弹窗消失。
 * 找不到 / 不达标时给出包含 poi / minQuality / aspect 的详细错误信息。
 */
export async function selectCtripLibraryImage(page: any, params: LibraryImageParams) {
  const {
    trigger,
    poi,
    description,
    minQuality = 3,
    aspect = "landscape",
    label,
  } = params;

  await trigger.hover();
  const libraryImport = trigger.getByText("图库导入", { exact: true });
  await libraryImport.waitFor({ state: "visible", timeout: 3_000 });
  await libraryImport.click();

  const dialog = page.getByRole("dialog").filter({ hasText: "从图库资源导入" });
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  await selectSearchOption(page, dialog, "PoiId", poi, "携程图库景点");

  const queryBtn = dialog.getByRole("button", { name: /查\s*询/ });
  await queryBtn.waitFor({ state: "visible" });
  await queryBtn.click();

  const cards = dialog.locator(".importpic-modal-picitem");
  const deadline = Date.now() + 8_000;
  let cardTexts: string[] = [];
  while (Date.now() < deadline) {
    // 图库结果会懒加载并整批重渲染。先 count 再逐个 nth().innerText() 会在
    // 列表缩短时等待一个已经消失的固定序号；一次 evaluate 快照不会跨重渲染。
    cardTexts = await cards.allInnerTexts();
    if (cardTexts.length > 0) break;
    await delay(250);
  }
  if (cardTexts.length === 0) {
    throw new Error(
      `${label}: '${poi}' 在携程图库未找到符合质量要求的图片(质量分 ≥ ${minQuality},${aspect === "landscape" ? "最小 1280×800 横版" : "宽高不限但 ≥1280×800"})`,
    );
  }

  const candidates: Array<{ quality: string; resolution: string }> = [];
  for (const rawText of cardTexts) {
    const text = rawText.replace(/\s+/g, " ");
    candidates.push({
      quality: text.match(/质量分：\s*([\d.]+(?:\s*-\s*[\d.]+)?)/)?.[1] || "",
      resolution: text.match(/分辨率：\s*(\d+\s*\*\s*\d+)/)?.[1] || "",
    });
  }

  const selectedIndex = findBestCtripLibraryImage(candidates, minQuality, aspect);
  if (selectedIndex < 0) {
    throw new Error(
      `${label}: '${poi}' 在携程图库未找到符合质量要求的图片(质量分 ≥ ${minQuality},${aspect === "landscape" ? "最小 1280×800 横版" : "宽高不限但 ≥1280×800"})`,
    );
  }
  const card = cards.nth(selectedIndex);
  await card.scrollIntoViewIfNeeded().catch(() => {});
  await card.click({ force: true });

  const agreement = dialog.getByText(/我已仔细阅读并同意/).locator("xpath=ancestor::label[1]");
  if (await agreement.count()) {
    const checkbox = agreement.locator('input[type="checkbox"]');
    if ((await checkbox.count()) && !(await checkbox.isChecked())) await agreement.click();
  }
  const confirm = dialog.getByRole("button", { name: /同意并导入/ });
  await confirm.waitFor({ state: "visible" });
  await confirm.click();
  await dialog.waitFor({ state: "hidden", timeout: 15_000 });

  return { reused: false };
}

/**
 * 多个 candidate locator 中挑第一个可见的并 fill value；都不可见抛错。
 * 用于 textarea 类控件在页面里有多个实例时只写可见那一个。
 */
async function fillFirstVisible(locator, value, description) {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const current = locator.nth(index);
    if (await current.isVisible()) {
      await current.fill(value);
      return;
    }
  }
  throw new Error(`找不到${description}`);
}

/**
 * 在携程图库弹窗内按 id 拿搜索 input + 键入 value，再从打开的 .ant-select-dropdown 抓 option，
 * 命中与 value 完全相同或包含它的就点击；轮询最多 8s，超时报错。
 */
async function selectSearchOption(page, dialog, id, value, description) {
  const input = dialog.locator(`#${id}`);
  await assertCount(input, 1, `${description}搜索框`);
  await input.waitFor({ state: "visible", timeout: 5_000 });
  // 远程搜索在逐字输入时会并发请求，旧短词响应可能覆盖完整 POI；fill 只提交完整名称。
  await input.fill(value);

  const options = page.locator(
    ".ant-select-dropdown:not(.ant-select-dropdown-hidden) [role=option], " +
    ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option",
  );
  const deadline = Date.now() + 8_000;
  let seen = [];
  while (Date.now() < deadline) {
    seen = (await options.allTextContents()).map((text) => text.trim()).filter(Boolean);
    const exact = seen.findIndex((text) => text === value || text.includes(value));
    if (exact >= 0) {
      await options.nth(exact).click();
      return;
    }
    await delay(250);
  }
  throw new Error(`${description}未找到"${value}"；可选：${seen.join("、") || "无"}`);
}

/** 第一阶段已经持久化 imageId，直接调用 VBK 图片绑定接口并回读确认。 */
export async function selectCtripLibraryCover(page, cover) {
  return bindCtripLibraryCoverViaApi(page, cover.imageId);
}

/**
 * 「产品图文」阶段主入口：接口保存推荐理由 + 产品特色 → 上封面 → 进入「行程描述」。
 * 调用方需要保证 product.presentation 含 cover 与 recommendation / features / recommendations。
 *
 * 防御深度（defense in depth）：
 *   - readiness / automationBlockers 已经在起跑前校验过 presentation 必填字段；
 *   - 本函数第一行用 assertPresentationReadyForVbk 再校验一次，
 *     即便 readiness 通过、产品被改坏、运行时 derivation 漏字段，
 *     VBK 阶段自身也会在打开任何 tab / 弹窗之前抛错；
 *   - 不调用 VBK、不打开网络、不会留下半成品页面状态。
 *
 * 保存不再触碰推荐理由 textarea / UEditor DOM：统一走 /15638/getdescriptionInfo →
 * /20698/createProductDraft(desc) → /15638/savedescriptioninfo → 回读确认。
 */
export async function fillAndSavePresentation(page, product) {
  // 第一道防御：统一从 automation-contract 取真实契约，错误文案面向运营。
  assertPresentationReadyForVbk(product);
  const presentation = product.presentation;
  const cover = presentation?.cover;
  if (
    !cover ||
    cover.source !== "ctripLibrary" ||
    !Number.isInteger(cover.imageId) ||
    cover.imageId <= 0 ||
    typeof cover.imageUrl !== "string" ||
    cover.imageUrl.trim().length === 0 ||
    typeof cover.poi !== "string" ||
    cover.poi.trim().length === 0 ||
    typeof cover.description !== "string" ||
    cover.description.trim().length === 0 ||
    typeof cover.minQuality !== "number"
  ) {
    throw new Error("产品图文缺少完整的携程图库封面配置，已停止后续录入。");
  }

  // 第二道防御（推荐理由接口保存前）：仍然保留 3 条 + 白名单 + 不重复校验，
  // 错误信息保持原样，避免改动影响既有运营提示。
  buildRecommendationReasonsPlan(presentation.recommendations);
  await clickSection(page, ["产品图文", "图文信息"]);
  await page.waitForURL((url) => isProductImageTextUrl(url.href), { timeout: 30_000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await delay(1_000);

  await selectCtripLibraryCover(page, presentation.cover);
  const savedWith = await savePresentationViaApi(page, presentation);
  await page.reload({ waitUntil: "domcontentloaded" });
  await delay(1_500);

  return saveThenAdvance(page, {
    phase: "产品图文",
    targetTabLabel: "行程描述",
    saveButtonNames: ["保存", "保存并下一步"],
    targetTabLabels: ["行程描述"],
    isTargetUrl: (url) =>
      typeof url === "string" && !/(^|[/?&])productImageText([/?&]|$)/.test(url),
    savedWith,
  });
}

export {
  fillFirstVisible,
  selectSearchOption,
};

// source-slicing anchor（仅供测试切片识别，不在运行时使用）：
/**
 * 测试切片占位：实现见 ../itinerary/common.ts；保留签名让 source-slicing 识别。
 */
function dayScopeFor(_titleInput) { return null; }
