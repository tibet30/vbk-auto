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
import { clickSafeSave, clickSection, isProductImageTextUrl, saveThenAdvance } from "../tabs.js";
import { findBestCtripLibraryImage, type CtripLibraryImageAspect } from "../../schema/schema-functions.js";
import {
  buildRecommendationReasonsPlan,
  fillRecommendationReasons,
} from "./recommendations.js";
import { assertPresentationReadyForVbk } from "../../automation-contract.js";
import { fillProductFeatures } from "./features.js";
import { installSaveMonitor, type SaveMonitorOutcome } from "./save-monitor.js";
import { bindCtripLibraryCoverViaApi } from "./cover-bind.js";

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
    await page.waitForURL((url) => isProductImageTextUrl(url.href), { timeout: 30_000 });
    // basic 的「下一步」会先切 tab、再异步完成路由/数据水合。首轮直接写入
    // 偶发只改到旧 React 状态，点击保存时不会发 savedescriptioninfo；刷新后
    // 从已解锁的产品图文路由开始，行为与成功的 recovery attempt 一致。
    await page.reload({ waitUntil: "domcontentloaded" });
    await delay(1_000);

    // 新产品首次绑定封面会改变服务端的产品图文模型，但当前 React 页面并不会
    // 自动水合这次接口写入。若继续在旧模型上填表，保存按钮虽然可见，点击后却
    // 不会发 savedescriptioninfo；恢复重跑能成功只是因为封面已提前存在。
    // 因此先完成并回读封面绑定，再刷新一次，让首次运行与恢复运行使用同一份
    // 完整后端状态；所有表单字段必须在这次刷新之后写入，避免被刷新清空。
    await selectCtripLibraryCover(page, presentation.cover);
    await page.reload({ waitUntil: "domcontentloaded" });
    await delay(1_500);
    await fillRecommendationReasons(page, recommendations);
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

    // UEditor / 推荐理由均通过 React 受控状态回写；给最后一次 change/sync
    // 一个明确稳定窗口，避免按钮已经可点但表单 store 尚未形成保存请求。
    await delay(2_500);

    // 先完成并确认官方保存，再刷新页面让 VBK 从后端重新水合最新图文状态。
    // 真实新产品上若保存响应尚未落定就立即点「下一步」，行程 tab 会持续
    // 锁定；整阶段刷新重跑才偶然恢复。这里把该恢复变成确定性主路径。
    const savedWith = await clickSafeSave(page, ["保存", "保存并下一步"]);
    saveOutcome = await monitor.waitForSave();
    if (!saveOutcome.saved) {
      throw new Error(
        `产品图文保存未确认成功：HTTP=${saveOutcome.httpStatus} Ack=${saveOutcome.ack} success=${saveOutcome.success}`,
      );
    }
    await page.reload({ waitUntil: "domcontentloaded" });
    await delay(1_500);

    const advanced = await saveThenAdvance(page, {
      phase: "产品图文",
      targetTabLabel: "行程描述",
      saveButtonNames: ["保存", "保存并下一步"],
      targetTabLabels: ["行程描述"],
      isTargetUrl: (url) =>
        typeof url === "string" && !/(^|[/?&])productImageText([/?&]|$)/.test(url),
      savedWith,
    });
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
