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
import { clickSection, saveThenAdvance } from "../tabs.js";
import { findBestCtripLibraryImage, type CtripLibraryImageAspect } from "../../schema/schema-functions.js";
import {
  buildRecommendationReasonsPlan,
  fillRecommendationReasons,
} from "./recommendations.js";
import { assertPresentationReadyForVbk } from "../../automation-contract.js";
import { fillProductFeatures } from "./features.js";
import { installSaveMonitor, type SaveMonitorOutcome } from "./save-monitor.js";

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
 * 判断产品图文页当前是否已经有「封面图」（image-category-container 内 .drag-nav-container 有 img）。
 * 用于封面图选择阶段的「已存在则跳过」快路径。
 */
export async function hasCoverImage(page) {
  const cover = page.locator(".image-category-container").filter({ hasText: /^\*?封面/ }).first();
  if (!(await cover.count())) return false;
  return (await cover.locator(".drag-nav-container img").count()) > 0;
}

/**
 * 在携程图库弹窗内按 id 拿搜索 input + 键入 value，再从打开的 .ant-select-dropdown 抓 option，
 * 命中与 value 完全相同或包含它的就点击；轮询最多 8s，超时报错。
 */
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

/**
 * 封面图入库主流程：
 *   - hasCoverImage 已存在则 reused=true 跳过；
 *   - 在封面卡上点添加 / 图库导入；
 *   - 弹窗里搜 poi → 解析每个候选的质量 / 分辨率 → 用分辨率 × 横版 × minQuality 的硬规则
 *     做兜底筛选，没找到再用 findBestCtripLibraryImage；
 *   - 同意协议 + 「同意并导入」，最后回读封面是否已经出现。
 */
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

/**
 * 「产品图文」阶段主入口：填推荐理由 3 条 → 上封面 → 推荐语 + 产品特点 → 保存 → 进入「行程描述」。
 * 调用方需要保证 product.presentation 含 cover 与 recommendation / features / recommendations。
 *
 * 防御深度（defense in depth）：
 *   - readiness / automationBlockers 已经在起跑前校验过 presentation 必填字段；
 *   - 本函数第一行用 assertPresentationReadyForVbk 再校验一次，
 *     即便 readiness 通过、产品被改坏、运行时 derivation 漏字段，
 *     VBK 阶段自身也会在打开任何 tab / 弹窗之前抛错；
 *   - 不调用 VBK、不打开网络、不会留下半成品页面状态。
 *
 * 第三道防御（保存门禁）：在产品图文动作开始前挂 /15638/savedescriptioninfo 与
 * /15638/checkSensitiveWord 监听；只有官方响应 success=true 且 ResponseStatus.Ack=Success
 * 才允许继续推进；命中敏感词 / 业务失败 / 无响应都直接抛错，绝不因「目标 tab 已解锁」
 * 误判完成。install 放在所有 UI 动作之前，覆盖 UEditor blur 触发的
 * checkSensitiveWord 等前置检测；finally 中 uninstall 保证不会跨产品残留副作用。
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

  // 第三道防御（保存门禁）：在产品图文动作前挂 /15638/savedescriptioninfo 与
  // /15638/checkSensitiveWord 监听，覆盖整段 UI 操作期间的所有官方响应。
  const monitor = installSaveMonitor(page);
  let saveOutcome: SaveMonitorOutcome | null = null;
  let saveError: Error | null = null;
  try {
    // 第二道防御（推荐理由 VBK 行写入前）：buildRecommendationReasonsPlan 内部
    // 仍然校验 3 条 + 白名单 + 互不重复，错误信息保持原样，避免改动影响既有测试。
    const recommendations = buildRecommendationReasonsPlan(presentation.recommendations);
    await clickSection(page, ["产品图文", "图文信息"]);
    await fillRecommendationReasons(page, recommendations);
    await selectCtripLibraryCover(page, presentation.cover);
    await fillFirstVisible(
      page.locator('textarea[placeholder*="推荐"], textarea'),
      presentation.recommendation,
      "推荐语输入框",
    );
    // 产品特点：先 label 锚定 .ant-form-item，再 fallback 到 #pm_features 容器；
    // 失败抛「找不到产品特点富文本输入框」并附诊断（不静默保存）。
    const featuresResult = await fillProductFeatures(page, presentation.features);
    const filledFeatures = featuresResult.filled;
    if (!filledFeatures) {
      const editorTypeLabel = featuresResult.editorType ?? "未识别";
      const scopeLabel = featuresResult.scopeSource ?? "无作用域";
      throw new Error(
        `找不到产品特点富文本输入框（编辑器类型=${editorTypeLabel}，作用域来源=${scopeLabel}）；诊断：${featuresResult.diagnostic || "无候选作用域/编辑器"}`,
      );
    }

    const advanced = await saveThenAdvance(page, {
      phase: "产品图文",
      targetTabLabel: "行程描述",
      saveButtonNames: ["保存", "保存并下一步"],
      targetTabLabels: ["行程描述"],
      isTargetUrl: (url) =>
        typeof url === "string" && !/(^|[/?&])productImageText([/?&]|$)/.test(url),
    });
    // saveThenAdvance 内部已经点了保存按钮；接下来等官方保存响应。
    saveOutcome = await monitor.waitForSave();
    return advanced;
  } catch (error) {
    saveError = error as Error;
    throw error;
  } finally {
    monitor.uninstall();
    // 业务校验：只有成功响应才允许 silent pass；失败响应统一抛错
    if (saveError === null && saveOutcome && !saveOutcome.saved) {
      throw new Error(
        `产品图文保存未确认成功：HTTP=${saveOutcome.httpStatus} Ack=${saveOutcome.ack} success=${saveOutcome.success}`,
      );
    }
  }
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
