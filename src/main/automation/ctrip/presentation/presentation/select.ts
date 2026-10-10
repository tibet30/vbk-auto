/**
 * 携程图库弹窗 + 搜索工具：
 *   - selectCtripLibraryImage：在「从图库资源导入」弹窗里搜 poi 并按已解析
 *     景点 POI 图片，确认协议并提交；适用于景点配图导入；
 *   - fillFirstVisible：多个候选 locator 中挑第一个可见并 fill；
 *   - selectSearchOption：在弹窗内按 id 拿搜索 input + 键入 value，再从
 *     打开的 .ant-select-dropdown 抓 option；轮询最多 8s 命中包含 value
 *     的选项并点击。
 */

import { delay, assertCount } from "../../utils.js";
import { findBestCtripLibraryImage, type CtripLibraryImageAspect } from "../../../schema/schema-functions.js";
import type { VbkLocator, VbkPage } from "../../locator-types.js";

export interface LibraryImageParams {
  trigger: VbkLocator;
  poi: string;
  description?: string;
  minQuality?: number;
  aspect?: CtripLibraryImageAspect;
  label: string;
}

export async function selectCtripLibraryImage(page: VbkPage, params: LibraryImageParams) {
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
export async function fillFirstVisible(locator: VbkLocator, value: string, description: string): Promise<void> {
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
export async function selectSearchOption(
  page: VbkPage,
  dialog: VbkLocator,
  id: string,
  value: string,
  description: string,
): Promise<void> {
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
  let seen: string[] = [];
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