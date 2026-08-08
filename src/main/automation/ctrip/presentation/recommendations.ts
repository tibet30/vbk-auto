// @ts-nocheck
/**
 * 产品图文页「推荐理由」3 行写入工具集：
 *   - buildRecommendationReasonsPlan：把 recommendations 校验成白名单内 3 项 + 类别不重复 + 文本非空；
 *   - appendRecommendationRow：在 #pm_recommend 末行点 + 按钮（图标 #1658DC）追加 1 行；
 *   - fillRecommendationReasons：主入口，先把行数补足到 3，再依次按行选中分类与填文本。
 * 顶部带 `// @ts-nocheck`，DOM 是动态 page。
 */

import { delay, escapeRegExp, assertCount } from "../utils.js";
import { RECOMMENDATION_CATEGORIES } from "../../schema/schema-definitions.js";

export interface RecommendationPlanStep {
  index: number;
  category: string;
  text: string;
}

/**
 * 把 recommendations 编译成推荐理由写入计划：
 *   - 必须 length=3；
 *   - category ∈ RECOMMENDATION_CATEGORIES；
 *   - text 非空；
 *   - category 不重复。
 * 任一不满足抛错，避免在 VBK 写入半成品。
 */
export function buildRecommendationReasonsPlan(
  recommendations: ReadonlyArray<{ category: string; text: string }>,
): RecommendationPlanStep[] {
  if (!Array.isArray(recommendations) || recommendations.length !== 3) {
    throw new Error("推荐理由必须为 3 项，请先在产品草稿中维护。");
  }
  const seen = new Set<string>();
  const plan: RecommendationPlanStep[] = [];
  for (let i = 0; i < 3; i += 1) {
    const item = recommendations[i] as { category: string; text: string };
    const { category, text } = item;
    if (!RECOMMENDATION_CATEGORIES.includes(category)) {
      throw new Error(`推荐理由分类「${category}」不在白名单。`);
    }
    if (!text || !text.trim()) {
      throw new Error(`推荐理由第 ${i + 1} 项文本为空。`);
    }
    if (seen.has(category)) {
      throw new Error(`推荐理由分类「${category}」重复。`);
    }
    seen.add(category);
    plan.push({ index: i, category, text });
  }
  return plan;
}

// VBK #pm_recommend 默认只渲染 1 行；plan 永远 3 项，所以开始填写前必须
// 把行数补足。两按钮共享相同的蓝图标；顺序固定为「− 在前、+ 在后」。
const RECOMMEND_APPEND_BUTTON_SELECTOR =
  'span.anticon[style*="rgb(22, 88, 220)"], span.anticon[style*="#1658DC"], span.anticon[style*="#1658dc"]';

/**
 * 在 #pm_recommend 末行点 + 按钮（蓝图标）追加一行；用 waitForFunction 等行数真到 currentCount+1。
 * - 找不到行 / + 按钮抛错（带 rowCount 信息便于排查 VBK DOM 变更）。
 * - 若一次 wait 超时，第二次再短超时兜一次（应对网络抖动 / React 重渲染）。
 */
async function appendRecommendationRow(page: any, currentCount: number) {
  const clicked = await page.evaluate((selector: string) => {
    const all = document.querySelectorAll("#pm_recommend .ant-form-item");
    if (all.length === 0) return { ok: false, reason: "empty" };
    const last = all[all.length - 1];
    const blues = last.querySelectorAll(selector);
    if (blues.length === 0) {
      return { ok: false, reason: "no-plus", rowCount: all.length };
    }
    blues[blues.length - 1].click();
    return { ok: true, rowCount: all.length };
  }, RECOMMEND_APPEND_BUTTON_SELECTOR);
  if (!clicked.ok) {
    if (clicked.reason === "empty") {
      throw new Error("推荐理由区域为空，无法定位最后一行追加新行");
    }
    throw new Error(
      `推荐理由最后一行缺少 + 按钮（VBK DOM 异常，行数=${clicked.rowCount}）`,
    );
  }
  const expectedCount = currentCount + 1;
  try {
    await page.waitForFunction(
      (target: number) =>
        document.querySelectorAll("#pm_recommend .ant-form-item").length >= target,
      expectedCount,
      { timeout: 10_000 },
    );
  } catch {
    await page.waitForFunction(
      (target: number) =>
        document.querySelectorAll("#pm_recommend .ant-form-item").length >= target,
      expectedCount,
      { timeout: 5_000 },
    );
  }
}

/**
 * 推荐理由 3 行写入主入口：
 *   - 先循环补足行数到 plan.length；
 *   - 每行按 select.ant-select / textarea.ant-input 定位；
 *   - 分类不对时打开下拉，挑 enabled 选项里的精确匹配，再回读校验选中值；
 *   - 文本后填 + 等待下一行可见（确保 VBK React 已渲染完成再动下一行）。
 */
export async function fillRecommendationReasons(page: any, recommendations: Array<{ category: string; text: string }>) {
  const plan = buildRecommendationReasonsPlan(recommendations);
  const section = page.locator("#pm_recommend");
  await assertCount(section, 1, "推荐理由区域");
  const rows = section.locator(".ant-form-item");

  let currentRowCount = await rows.count();
  while (currentRowCount < plan.length) {
    await appendRecommendationRow(page, currentRowCount);
    await delay(150);
    currentRowCount = await rows.count();
  }

  for (let i = 0; i < plan.length; i += 1) {
    const targetCategory = plan[i]!.category;
    const targetText = plan[i]!.text;
    const row = rows.nth(i);
    await row.waitFor({ state: "visible", timeout: 10_000 });

    const label = row.locator('label[title="推荐理由"]');
    const select = row.locator("div.ant-select");
    const selectionItem = select.locator("span.ant-select-selection-item");
    const combobox = select.locator('input.ant-select-selection-search-input[role="combobox"]');
    const textarea = row.locator("textarea.ant-input");
    await assertCount(label, 1, `第 ${i + 1} 组推荐理由 label`);
    await assertCount(select, 1, `第 ${i + 1} 组推荐理由 div.ant-select`);
    await assertCount(combobox, 1, `第 ${i + 1} 组推荐理由 combobox input`);
    await assertCount(textarea, 1, `第 ${i + 1} 组推荐理由 textarea`);

    const currentCategory = (
      await selectionItem.first().innerText().catch(() => "")
    ).trim();

    if (currentCategory !== targetCategory) {
      const selector = select.locator("div.ant-select-selector");
      await selector.waitFor({ state: "visible", timeout: 5_000 });
      await selector.click();
      await delay(400);
      const dropdownPanel = page.locator(
        ".ant-select-dropdown:not(.ant-select-dropdown-hidden)",
      );
      await dropdownPanel.first().waitFor({ state: "visible", timeout: 5_000 });
      const options = dropdownPanel
        .first()
        .locator(
          ".ant-select-item-option:not(.ant-select-item-option-disabled):not(.ant-select-dropdown-menu-item-disabled):not([aria-disabled=\"true\"])",
        );
      await options.first().waitFor({ state: "visible", timeout: 5_000 });
      const enabledTexts = (await options.allTextContents()).map((text) => text.trim());
      const optionIndex = enabledTexts.indexOf(targetCategory);
      if (optionIndex < 0) {
        const allOptions = dropdownPanel.first().locator(".ant-select-item-option, .ant-select-dropdown-menu-item");
        const allTexts = (await allOptions.allTextContents()).map((text) => text.trim());
        const disabledOnly = allTexts.includes(targetCategory);
        if (disabledOnly) {
          throw new Error(
            `第 ${i + 1} 组推荐理由没有可用的精确选项「${targetCategory}」（同名项仅以 disabled 形式存在）；可选：${enabledTexts.join("、") || "无"}`,
          );
        }
        throw new Error(
          `第 ${i + 1} 组推荐理由未找到「${targetCategory}」；可选：${enabledTexts.join("、")}`,
        );
      }
      await options.nth(optionIndex).click();
      try {
        await dropdownPanel.first().waitFor({ state: "hidden", timeout: 5_000 });
      } catch {
        // 下拉层关闭时机不可控，容忍此类瞬态行为
      }
      const targetItem = select.locator(
        "span.ant-select-selection-item",
        { hasText: new RegExp(`^${escapeRegExp(targetCategory)}$`) },
      );
      try {
        await targetItem.first().waitFor({ state: "visible", timeout: 5_000 });
      } catch {
        const actual = (await selectionItem.first().innerText().catch(() => "")).trim();
        throw new Error(`第 ${i + 1} 组推荐理由未选中「${targetCategory}」；当前：${actual}`);
      }
      const actual = (await selectionItem.first().innerText().catch(() => "")).trim();
      if (actual !== targetCategory) {
        throw new Error(`第 ${i + 1} 组推荐理由未选中「${targetCategory}」；当前：${actual}`);
      }
    }

    await textarea.fill(targetText);

    if (i < 2) {
      const nextRow = rows.nth(i + 1);
      try {
        await nextRow.waitFor({ state: "visible", timeout: 10_000 });
      } catch {
        throw new Error(`第 ${i + 1} 组填写后未生成第 ${i + 2} 组`);
      }
      await nextRow.locator('label[title="推荐理由"]').first().waitFor({
        state: "visible",
        timeout: 5_000,
      });
      await nextRow.locator("div.ant-select").first().waitFor({
        state: "visible",
        timeout: 5_000,
      });
      await nextRow.locator("textarea.ant-input").first().waitFor({
        state: "visible",
        timeout: 5_000,
      });
    }
  }
}

export {
  RECOMMEND_APPEND_BUTTON_SELECTOR,
  appendRecommendationRow,
};