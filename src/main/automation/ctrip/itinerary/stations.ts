// @ts-nocheck
/**
 * 行程中的「接送站」子模块：
 *   - selectStationAddress：在弹窗里为 airport / train 两个下拉填入 city，自动挑唯一匹配或
 *     调用注入的 disambiguator（AI）做兜底消歧；
 *   - fillPickupAndDropoff：首日 / 末日分别在「集合」「解散」card 里勾方式选项 + 调用上面填站；
 *   - handleAirportTrainModal：当「请选择机场/火车站」modal 出现时的统一处理入口。
 * 顶部带 `// @ts-nocheck`，依赖 debug 的 breakpoint 工具便于手动复现。
 */

import { delay, escapeRegExp } from "../utils.js";
import { breakpoint } from "../../debug.js";
import { cardsByPrefix, ensureCheckboxChecked } from "./common.js";

// 暴露给 debug：直接调这个函数能复现「接送站」单步场景。
export async function selectStationAddress(page, card, city, extra = {}) {
  const disambiguator = extra?.disambiguator;
  const product = extra?.product ?? {};
  await breakpoint("selectStationAddress:enter", { city });
  const addressInput = card.locator('input.ant-input[placeholder="请选择"]');
  const addressCount = await addressInput.count();
  if (!addressCount) throw new Error("接送站地址输入框缺失");
  await safeClick(page, addressInput.first());
  await delay(300);
  const dialog = page.getByRole("dialog");
  try {
    await dialog.waitFor({ state: "visible", timeout: 5_000 });
  } catch (e) {
    console.warn("[selectStationAddress] dialog 没出现，card.first() 可能是其他控件");
    return { matched: false, reason: "dialog-not-visible" };
  }
  const inputs = dialog.locator("input");
  const dialogInputCount = await inputs.count();
  console.warn(`[selectStationAddress] dialog inputs=${dialogInputCount}`);
  if (dialogInputCount < 2) {
    console.warn("[selectStationAddress] 弹窗 inputs 不足 2 个");
    return { matched: false, reason: "dialog-inputs-less-than-2" };
  }

  async function fillStationField(fieldIndex, kind) {
    const input = inputs.nth(fieldIndex);
    await safeClick(page, input);
    await input.fill("").catch(() => {});
    await input.type(city, { delay: 80 });
    await delay(3_000);
    const dropdown = page.locator(
      '.ant-select-dropdown:not(.ant-select-dropdown-hidden)',
    ).last();
    /**
     * 收起遮罩型 ant-tooltip / ant-popover，让 select-dropdown 的可见性探测不被干扰。
     */
    async function collapseOverlayTooltips() {
      await page.keyboard.press("Escape").catch(() => false);
      await delay(100);
    }
    try {
      await dropdown.waitFor({ state: "visible", timeout: 3_000 });
    } catch {
      await collapseOverlayTooltips();
      await dropdown.waitFor({ state: "visible", timeout: 3_000 });
    }
    const options = dropdown.locator('.ant-select-dropdown-menu-item');
    const total = await options.count().catch(() => 0);
    console.warn(`[selectStationAddress/fillStationField] kind=${kind} dropdown count=${total}`);
    if (!total) {
      try {
        await input.fill("").catch(() => {});
        await input.type(city, { delay: 120 });
        await delay(4_000);
        const total2 = await options.count().catch(() => 0);
        if (total2 > 0) {
          const texts2 = (await options.allInnerTexts().catch(() => [])).map((text) => text.trim());
          const idx2 = texts2.indexOf(city);
          if (idx2 >= 0) {
            await options.nth(idx2).click({ force: true });
            await delay(200);
            await page.keyboard.press("Escape").catch(() => false);
            await delay(150);
            return { matched: true, source: "retry-exact", text: city };
          }
          if (texts2.length === 1) {
            await options.nth(0).click({ force: true });
            await delay(200);
            await page.keyboard.press("Escape").catch(() => false);
            await delay(150);
            return { matched: true, source: "retry-single", text: texts2[0] };
          }
        }
      } catch (retryErr) {
        console.warn("[selectStationAddress/fillStationField] retry 失败", String(retryErr));
      }
      return { matched: false, reason: "empty-list" };
    }
    const texts = (await options.allInnerTexts().catch(() => [])).map((text) => text.trim());
    console.warn(`[selectStationAddress/fillStationField] kind=${kind} texts=`, texts.slice(0, 5));
    const disableds = await Promise.all(
      Array.from({ length: total }, async (_, i) => {
        const cls = (await options.nth(i).getAttribute("class").catch(() => "")) || "";
        return /ant-select-item-disabled|ant-select-dropdown-menu-item-disabled/.test(cls);
      }),
    );
    const usable = texts.filter((_, i) => !disableds[i]);
    console.warn(`[selectStationAddress/fillStationField] kind=${kind} usable=${usable.length}, city=${city}`);
    if (usable.length === 1) {
      const idx = texts.findIndex((t) => t === usable[0]);
      await delay(150);
      await options.nth(idx).click({ force: true });
      await delay(200);
      await page.keyboard.press("Escape").catch(() => false);
      await delay(150);
      return { matched: true, source: "single", text: usable[0] };
    }
    const exactIdx = usable.findIndex((t) => t.trim() === city);
    if (exactIdx >= 0) {
      const idx = texts.findIndex((t) => t === usable[exactIdx]);
      await delay(150);
      await options.nth(idx).click({ force: true });
      await delay(200);
      await page.keyboard.press("Escape").catch(() => false);
      await delay(150);
      return { matched: true, source: "exact", text: usable[exactIdx] };
    }
    if (disambiguator && usable.length > 0) {
      const candidates = texts.map((text, i) => ({ index: i, text }));
      try {
        const aiMatch = await disambiguator(
          candidates,
          disableds,
          [city, `${city}站`, `${city}南站`, `${city}北站`, `${city}东站`, `${city}西站`, `${city}机场`],
          { kind, desired: city, product, description: `${kind}接送站` },
        );
        let chosenIndex = -1;
        if (aiMatch && typeof aiMatch.index === "number" && candidates[aiMatch.index] && !disableds[aiMatch.index]) {
          chosenIndex = aiMatch.index;
        } else if (aiMatch && aiMatch.pickedText) {
          const idx = candidates.findIndex((c) => c.text === aiMatch.pickedText);
          if (idx >= 0 && !disableds[idx]) chosenIndex = idx;
        }
        if (chosenIndex >= 0) {
          await delay(150);
          await options.nth(chosenIndex).click({ force: true });
          await delay(200);
          await page.keyboard.press("Escape").catch(() => false);
          await delay(150);
          return {
            matched: true,
            source: "ai",
            text: candidates[chosenIndex].text,
            reasoning: aiMatch.reasoning,
          };
        }
      } catch (err) {
        console.warn("[selectStationAddress] AI 兜底失败，跳过本字段", { kind, err: String(err.message || err) });
      }
    }
    await collapseOverlayTooltips();
    return { matched: false, reason: "no-match", candidates: usable };
  }

  const airportResult = await fillStationField(0, "airport");
  console.info("[selectStationAddress] airport", JSON.stringify(airportResult));
  await delay(300);
  const trainResult = await fillStationField(1, "train");
  console.info("[selectStationAddress] train", JSON.stringify(trainResult));
  const confirm = dialog.getByRole("button", { name: "确定", exact: true });
  if (await confirm.count()) {
    await safeClick(page, confirm, { force: true }).catch(() => false);
    await delay(300);
    if (await dialog.isVisible().catch(() => false)) {
      await safeClick(page, confirm, { force: true }).catch(() => false);
      await delay(300);
    }
  }
  await page.keyboard.press("Escape").catch(() => false);
  await breakpoint("selectStationAddress:done");
}

/**
 * 单天接送：首天 / 末日分别处理。
 *   - 首天：在「集合」card 勾第 3 个 checkbox，再调用 selectStationAddress 填站；
 *   - 末日：在「解散」card 勾第 2 个 checkbox，若 reusePickupForDropoff 则再勾第 3 个；
 *   - 找到的 card / checkbox 数量不符 → 抛「结构异常」。
 */
async function fillPickupAndDropoff(page, dayScope, index, totalDays, operations, extra = {}) {
  const disambiguator = extra?.disambiguator;
  const product = extra?.product;
  async function fillEmptyStationAddresses(card) {
    const stationInputs = card.locator('input.ant-input[placeholder="请选择"]');
    const total = await stationInputs.count();
    for (let i = 0; i < total; i += 1) {
      const input = stationInputs.nth(i);
      const value = await input.getAttribute("value").catch(() => "");
      if (value && value.trim()) continue;
      const inputClass = (await input.getAttribute("class")) || "";
      if (/ant-time-picker-input/.test(inputClass)) continue;
      await selectStationAddress(page, card, operations.pickupCity, { disambiguator, product });
      return;
    }
  }
  if (index === 0) {
    const cards = await cardsByPrefix(dayScope, "集合");
    if (cards.length !== 1) throw new Error("首日集合节点结构异常");
    const modes = cards[0].getByRole("checkbox");
    if ((await modes.count()) < 3) throw new Error("首日集合方式控件结构异常");
    await ensureCheckboxChecked(modes.nth(2));
    await delay(300);
    await fillEmptyStationAddresses(cards[0]);
  }
  if (index === totalDays - 1) {
    const cards = await cardsByPrefix(dayScope, "解散");
    if (cards.length !== 1) throw new Error("末日解散节点结构异常");
    let modes = cards[0].getByRole("checkbox");
    if ((await modes.count()) < 2) throw new Error("末日解散方式控件结构异常");
    await ensureCheckboxChecked(modes.nth(1));
    await delay(300);
    modes = cards[0].getByRole("checkbox");
    if (operations.reusePickupForDropoff) {
      if ((await modes.count()) >= 3) {
        await ensureCheckboxChecked(modes.nth(2));
      }
    }
    await fillEmptyStationAddresses(cards[0]);
  }
}

/**
 * 处理「请选择机场/火车站」modal：先点开机场输入框填 city 找 `${city}机场`；再点火车输入框
 * 找 `${city}`；最后确定。失败时按当前 enabled 的第一项兜底选择，返回是否成功关闭。
 */
async function handleAirportTrainModal(page, city) {
  const modalTitle = page.locator('.ant-modal-title').filter({ hasText: "请选择机场/火车站" });
  if ((await modalTitle.count()) === 0) return false;
  const modal = modalTitle.first().locator("xpath=ancestor::*[contains(@class,\"ant-modal\")][1]");
  if (!(await modal.isVisible().catch(() => false))) return false;
  console.warn('[handleAirportTrainModal] 检测到“请选择机场/火车站”modal，开始处理');
  const searchInputs = modal.locator('input.ant-select-search__field');
  const inputCount = await searchInputs.count();
  if (inputCount < 2) {
    console.warn("[handleAirportTrainModal] modal 输入数量不足：", inputCount);
    return false;
  }
  await searchInputs.nth(0).click({ force: true });
  await delay(300);
  await searchInputs.nth(0).fill("");
  await searchInputs.nth(0).type(city, { delay: 80 });
  await delay(500);
  const airportOption = page.locator('.ant-select-dropdown-menu-item').filter({
    hasText: new RegExp(`^${escapeRegExp(city)}机场$`),
  }).first();
  if ((await airportOption.count()) === 0) {
    await page.locator('.ant-select-dropdown-menu-item:not(.ant-select-dropdown-menu-item-disabled)').first().click({ force: true }).catch(() => {});
  } else {
    await airportOption.click({ force: true });
  }
  await delay(500);
  await searchInputs.nth(1).click({ force: true });
  await delay(300);
  await searchInputs.nth(1).fill("");
  await searchInputs.nth(1).type(city, { delay: 80 });
  await delay(500);
  const trainOption = page.locator('.ant-select-dropdown-menu-item').filter({
    hasText: new RegExp(`^${escapeRegExp(city)}$`),
  }).first();
  if ((await trainOption.count()) === 0) {
    await page.locator('.ant-select-dropdown-menu-item:not(.ant-select-dropdown-menu-item-disabled)').first().click({ force: true }).catch(() => {});
  } else {
    await trainOption.click({ force: true });
  }
  await delay(500);
  const confirm = modal.getByRole("button", { name: "确定", exact: true });
  if ((await confirm.count()) === 0) {
    console.warn("[handleAirportTrainModal] 未找到\"确定\"按钮");
    return false;
  }
  await confirm.first().click({ force: true });
  await delay(2_000);
  return true;
}

declare function safeClick(page: any, locator: any, options?: any): Promise<any>;

export {
  fillPickupAndDropoff,
  handleAirportTrainModal,
};