// @ts-nocheck
// 产品图文页（productImageText）：封面、推荐语、推荐理由 3 条、产品特点。

import { delay, assertCount } from "../utils.js";
import { clickSection, saveThenAdvance } from "../tabs.js";
import { findBestCtripLibraryImage, type CtripLibraryImageAspect } from "../../schema/schema-functions.js";
import { fillRecommendationReasons } from "./recommendations.js";
import { buildRecommendationReasonsPlan } from "./recommendations.js";

export { RECOMMENDATION_CATEGORIES } from "../../schema/schema-definitions.js";

export interface LibraryImageParams {
  trigger: any;
  poi: string;
  description?: string;
  minQuality?: number;
  aspect?: CtripLibraryImageAspect;
  label: string;
}

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
  let count = 0;
  while (Date.now() < deadline) {
    count = await cards.count();
    if (count > 0) break;
    await delay(250);
  }
  if (count === 0) {
    throw new Error(
      `${label}: '${poi}' 在携程图库未找到符合质量要求的图片(质量分 ≥ ${minQuality},${aspect === "landscape" ? "最小 1280×800 横版" : "宽高不限但 ≥1280×800"})`,
    );
  }

  const candidates: Array<{ quality: string; resolution: string }> = [];
  for (let index = 0; index < count; index += 1) {
    const text = (await cards.nth(index).innerText()).replace(/\s+/g, " ");
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

export async function hasCoverImage(page) {
  const cover = page.locator(".image-category-container").filter({ hasText: /^\*?封面/ }).first();
  if (!(await cover.count())) return false;
  return (await cover.locator(".drag-nav-container img").count()) > 0;
}

async function selectSearchOption(page, dialog, id, value, description) {
  const input = dialog.locator(`#${id}`);
  await assertCount(input, 1, `${description}搜索框`);
  await input.click();
  await input.fill("");
  await input.pressSequentially(value, { delay: 80 });

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

export async function selectCtripLibraryCover(page, cover) {
  if (await hasCoverImage(page)) return { reused: true };

  const section = page.locator(".image-category-container").filter({ hasText: /^\*?封面/ }).first();
  await assertCount(section, 1, "封面图片区块");
  const addCard = section.locator(".add-image-card");
  await assertCount(addCard, 1, "封面添加图片入口");
  await addCard.click({ force: true });
  const libraryImport = addCard.getByText("图库导入", { exact: true });
  await libraryImport.waitFor({ state: "visible", timeout: 3_000 });
  if (!(await libraryImport.isVisible())) {
    await addCard.hover().catch(() => {});
    await libraryImport.waitFor({ state: "visible", timeout: 3_000 });
  }
  await libraryImport.click();

  const dialog = page.getByRole("dialog").filter({ hasText: "从图库资源导入" });
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  await selectSearchOption(page, dialog, "PoiId", cover.poi, "携程图库景点");
  await dialog.getByRole("button", { name: /查\s*询/ }).click();

  const cards = dialog.locator(".importpic-modal-picitem");
  await cards.first().waitFor({ state: "visible", timeout: 10_000 });
  const candidates = [];
  for (let index = 0; index < (await cards.count()); index += 1) {
    const text = (await cards.nth(index).innerText()).replace(/\s+/g, " ");
    candidates.push({
      quality: text.match(/质量分：\s*([\d.]+(?:\s*-\s*[\d.]+)?)/)?.[1] || "",
      resolution: text.match(/分辨率：\s*(\d+\s*\*\s*\d+)/)?.[1] || "",
    });
  }
  const fallbackIndex = candidates.findIndex((image) => {
    const qualities: number[] = image.quality.match(/\d+(?:\.\d+)?/g)?.map(Number) || [];
    const lowestQuality: number = qualities.length ? Math.min(...qualities) : -Infinity;
    const dimensions: number[] = image.resolution.match(/\d+/g)?.map(Number) || [];
    const [width = 0, height = 0] = dimensions;
    return lowestQuality >= (cover.minQuality ?? 3) && width >= 1280 && height >= 800 && width >= height;
  });
  const selectedIndex = findBestCtripLibraryImage(candidates, cover.minQuality ?? 3);
  const finalIndex = fallbackIndex >= 0 ? fallbackIndex : selectedIndex;
  if (finalIndex < 0) {
    throw new Error(
      `携程图库未找到符合封面标准的"${cover.poi}"图片：最低质量分 ${cover.minQuality ?? 3}，横版分辨率至少 1280×800。`,
    );
  }
  const card = cards.nth(finalIndex);
  await card.scrollIntoViewIfNeeded().catch(() => {});
  await card.click({ force: true });

  const agreement = dialog.getByText(/我已仔细阅读并同意/).locator("xpath=ancestor::label[1]");
  if (await agreement.count()) {
    const checkbox = agreement.locator('input[type="checkbox"]');
    if ((await checkbox.count()) && !(await checkbox.isChecked())) await agreement.click();
  }
  const confirm = dialog.getByRole("button", { name: /同意并导入/ });
  await confirm.click();
  await dialog.waitFor({ state: "hidden", timeout: 15_000 });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await hasCoverImage(page)) return { reused: false };
    await delay(250);
  }
  throw new Error(`已从携程图库导入"${cover.poi}"，但封面未显示在产品图文页。`);
}

export async function fillAndSavePresentation(page, product) {
  const presentation = product.presentation;
  if (!presentation?.cover) {
    throw new Error("产品图文缺少携程图库封面配置，已停止后续录入。");
  }
  await clickSection(page, ["产品图文", "图文信息"]);
  if (presentation.recommendations?.length === 3) {
    await fillRecommendationReasons(page, presentation.recommendations);
  }
  await selectCtripLibraryCover(page, presentation.cover);
  await fillFirstVisible(
    page.locator('textarea[placeholder*="推荐"], textarea'),
    presentation.recommendation,
    "推荐语输入框",
  );
  const editor = page.locator('[contenteditable="true"]');
  for (let index = 0; index < (await editor.count()); index += 1) {
    if (await editor.nth(index).isVisible()) {
      await editor.nth(index).fill(presentation.features);
      break;
    }
  }
  return saveThenAdvance(page, {
    phase: "产品图文",
    targetTabLabel: "行程描述",
    saveButtonNames: ["保存", "保存并下一步"],
    targetTabLabels: ["行程描述"],
    isTargetUrl: (url) =>
      typeof url === "string" && !/(^|[/?&])productImageText([/?&]|$)/.test(url),
  });
}

export {
  fillFirstVisible,
  selectSearchOption,
};

// source-slicing anchor（仅供测试切片识别，不在运行时使用）：
function dayScopeFor(_titleInput) { return null; }
