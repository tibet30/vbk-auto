// @ts-nocheck
/**
 * 行程中的「接送站」子模块：
 *   - selectStationAddress：在弹窗里为 airport / train 两个下拉填入 city，自动挑唯一匹配或
 *     调用注入的 disambiguator（AI）做兜底消歧；
 *   - fillPickupAndDropoff：首日 / 末日分别在「集合」「解散」card 里勾方式选项 + 调用上面填站；
 *   - handleAirportTrainModal：当「请选择机场/火车站」modal 出现时的统一处理入口。
 * 顶部带 `// @ts-nocheck`，依赖 debug 的 breakpoint 工具便于手动复现。
 */

import { delay, escapeRegExp, safeClick } from "../utils.js";
import { breakpoint } from "../../debug.js";
import { cardsByPrefix, ensureCheckboxChecked } from "./common.js";
import { logInfo, logWarn } from "../../../../shared/log-timestamp.js";

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
    logWarn("[selectStationAddress] dialog 没出现，card.first() 可能是其他控件");
    return { matched: false, reason: "dialog-not-visible" };
  }
  const inputs = dialog.locator("input");
  const dialogInputCount = await inputs.count();
  logWarn(`[selectStationAddress] dialog inputs=${dialogInputCount}`);
  if (dialogInputCount < 2) {
    logWarn("[selectStationAddress] 弹窗 inputs 不足 2 个");
    return { matched: false, reason: "dialog-inputs-less-than-2" };
  }

  async function fillStationField(fieldIndex, kind) {
    const input = inputs.nth(fieldIndex);
    await safeClick(page, input);
    await input.fill("").catch(() => {});
    await input.type(city, { delay: 80 });
    // 不再固定等待 3 秒：下拉自身的 visible/option 门控已经覆盖远程加载，
    // 固定 sleep 会让同一弹窗的机场、火车站以及整组集成测试线性变慢。
    await delay(300);
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
    await options.first().waitFor({ state: "visible", timeout: 3_000 }).catch(() => undefined);
    const total = await options.count().catch(() => 0);
    logWarn(`[selectStationAddress/fillStationField] kind=${kind} dropdown count=${total}`);
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
        logWarn("[selectStationAddress/fillStationField] retry 失败", String(retryErr));
      }
      return { matched: false, reason: "empty-list" };
    }
    const texts = (await options.allInnerTexts().catch(() => [])).map((text) => text.trim());
    logWarn(`[selectStationAddress/fillStationField] kind=${kind} texts=`, texts.slice(0, 5));
    const disableds = await Promise.all(
      Array.from({ length: total }, async (_, i) => {
        const cls = (await options.nth(i).getAttribute("class").catch(() => "")) || "";
        return /ant-select-item-disabled|ant-select-dropdown-menu-item-disabled/.test(cls);
      }),
    );
    const usable = texts.filter((_, i) => !disableds[i]);
    logWarn(`[selectStationAddress/fillStationField] kind=${kind} usable=${usable.length}, city=${city}`);
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
    // 城市机场候选可能使用机场专名（例如“武宿国际机场”），不含城市名。
    // 在没有 AI 消歧器时，优先唯一的国际机场/城市机场，避免把机场地址静默留空。
    if (!disambiguator && kind === "airport") {
      const primary = usable
        .map((text, index) => ({ text, index }))
        .filter(({ text }) => text.includes("国际机场") || new RegExp(`${escapeRegExp(city)}机场`).test(text));
      if (primary.length === 1) {
        await options.nth(texts.findIndex((text) => text === primary[0].text)).click({ force: true });
        await delay(200);
        await page.keyboard.press("Escape").catch(() => false);
        await delay(150);
        return { matched: true, source: "primary-airport", text: primary[0].text };
      }
    }
    if (disambiguator && usable.length > 0) {
      const candidates = texts.map((text, i) => ({ index: i, text }));
      const stationSubtype = kind === "airport" ? "airport" : "train";
      try {
        const aiCandidates = candidates
          .filter((candidate) => !disableds[candidate.index])
          .map((candidate) => ({ id: String(candidate.index), text: candidate.text }));
        logInfo("[selectStationAddress] AI 兜底请求", {
          field: kind,
          desired: city,
          candidates: aiCandidates.map((candidate) => candidate.text),
        });
        const aiMatch = await disambiguator({
          kind: "station",
          stationSubtype,
          desired: city,
          candidates: aiCandidates,
          product,
        });
        let chosenIndex = -1;
        if (aiMatch && aiMatch.pickedText) {
          const idx = candidates.findIndex((c) => c.text === aiMatch.pickedText);
          if (idx >= 0 && !disableds[idx]) chosenIndex = idx;
        }
        if (chosenIndex >= 0) {
          logInfo("[selectStationAddress] AI 兜底选中", {
            field: kind,
            desired: city,
            picked: candidates[chosenIndex].text,
            reasoning: aiMatch.reasoning,
          });
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
        logWarn("[selectStationAddress] AI 兜底失败，跳过本字段", { kind, err: String(err.message || err) });
      }
    }
    await collapseOverlayTooltips();
    return { matched: false, reason: "no-match", candidates: usable };
  }

  const airportResult = await fillStationField(0, "airport");
  logInfo("[selectStationAddress] airport", JSON.stringify(airportResult));
  await delay(300);
  const trainResult = await fillStationField(1, "train");
  logInfo("[selectStationAddress] train", JSON.stringify(trainResult));
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
  async function ensureNamedMode(card, labelText, description) {
    const labels = card.getByText(labelText, { exact: true });
    for (let i = 0; i < await labels.count(); i += 1) {
      const text = labels.nth(i);
      if (!(await text.isVisible().catch(() => false))) continue;
      const wrapper = text.locator("xpath=ancestor::label[contains(@class,'ant-checkbox-wrapper')][1]");
      if (!(await wrapper.count())) continue;
      const target = wrapper.first();
      const input = target.locator('input[type="checkbox"]');
      if (await input.isChecked().catch(() => false)) return;
      await target.click({ force: true });
      if (await input.isChecked().catch(() => false)) return;
      await input.check({ force: true }).catch(() => undefined);
      if (await input.isChecked().catch(() => false)) return;
    }
    throw new Error(`${description}未形成选中状态`);
  }
  async function setAllDay(card, description) {
    const deadline = Date.now() + 5_000;
    // 新版 VBK 的「全天」值为 D，旧版曾使用 0。逐个检查可见 wrapper，
    // 避免跨 card / 隐藏节点的同名文本被误定位。
    while (Date.now() < deadline) {
      const radios = card.locator('input[type="radio"][value="D"], input[type="radio"][value="0"]');
      for (let i = 0; i < await radios.count(); i += 1) {
        const radio = radios.nth(i);
        const label = radio.locator("xpath=ancestor::label[contains(@class,'ant-radio-wrapper')][1]");
        if (!(await label.count()) || !(await label.isVisible().catch(() => false))) continue;
        if (!/全天/.test((await label.innerText().catch(() => "")).trim())) continue;
        // 真实 VBK 的可服务时间 radio 是受控组件：force click 会绕过它的
        // 正常命中链，视觉上完成 click 但 React state 仍保持未选中。
        // 这里必须走普通 label click；失败则由外层短轮询重新解析后再试。
        if (!(await radio.isChecked().catch(() => false))) {
          await label.scrollIntoViewIfNeeded().catch(() => undefined);
          await label.click({ timeout: 2_000 }).catch(() => undefined);
        }
        if (await radio.isChecked().catch(() => false)) return;
      }
      await delay(200);
    }
    throw new Error(`找不到可设置的${description}`);
  }
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
    await ensureNamedMode(cards[0], "接机/站", "首日接送站方式");
    await setAllDay(cards[0], "首日集合时间");
    await delay(300);
    await fillEmptyStationAddresses(cards[0]);
  }
  if (index === totalDays - 1) {
    const cards = await cardsByPrefix(dayScope, "解散");
    if (cards.length !== 1) throw new Error("末日解散节点结构异常");
    let modes = cards[0].getByRole("checkbox");
    if ((await modes.count()) < 2) throw new Error("末日解散方式控件结构异常");
    await ensureNamedMode(cards[0], "送机/站", "末日接送站方式");
    await setAllDay(cards[0], "末日解散时间");
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
async function handleAirportTrainModal(page, city, extra = {}) {
  const disambiguator = extra?.disambiguator;
  const product = extra?.product ?? {};
  const modalTitle = page.locator('.ant-modal-title').filter({ hasText: "请选择机场/火车站" });
  if ((await modalTitle.count()) === 0) return false;
  const modal = modalTitle.first().locator("xpath=ancestor::*[contains(@class,\"ant-modal\")][1]");
  if (!(await modal.isVisible().catch(() => false))) return false;
  logWarn('[handleAirportTrainModal] 检测到“请选择机场/火车站”modal，开始处理');
  const searchInputs = modal.locator('input.ant-select-search__field');
  const inputCount = await searchInputs.count();
  if (inputCount < 2) {
    logWarn("[handleAirportTrainModal] modal 输入数量不足：", inputCount);
    return false;
  }

  async function selectField(fieldIndex, stationSubtype, aliases) {
    const input = searchInputs.nth(fieldIndex);
    await input.click({ force: true });
    await delay(300);
    await input.fill("");
    await input.type(city, { delay: 80 });
    await delay(800);
    const options = page.locator('.ant-select-dropdown-menu-item');
    const total = await options.count().catch(() => 0);
    const texts = (await options.allInnerTexts().catch(() => [])).map((text) => text.trim());
    const disableds = await Promise.all(
      Array.from({ length: total }, async (_, i) => {
        const cls = (await options.nth(i).getAttribute("class").catch(() => "")) || "";
        return /ant-select-item-disabled|ant-select-dropdown-menu-item-disabled/.test(cls);
      }),
    );
    logWarn(`[handleAirportTrainModal] ${stationSubtype} candidates=`, texts.slice(0, 8));
    const usableIndexes = texts
      .map((text, index) => ({ text, index }))
      .filter((entry) => entry.text && !disableds[entry.index] && !/^(?:not\s*found|loading|加载中|暂无数据|暂无结果|搜索中|请选择)$/i.test(entry.text))
      .map((entry) => entry.index);
    if (!usableIndexes.length) return { matched: false, reason: "empty-list" };
    for (const alias of aliases) {
      const exactIndex = usableIndexes.find((index) => texts[index] === alias);
      if (typeof exactIndex === "number") {
        await options.nth(exactIndex).click({ force: true });
        await delay(500);
        return { matched: true, source: "exact", text: texts[exactIndex] };
      }
    }
    if (disambiguator) {
      const aiCandidates = usableIndexes.map((index) => ({ id: String(index), text: texts[index] }));
      try {
        logInfo("[handleAirportTrainModal] AI 兜底请求", {
          stationSubtype,
          desired: city,
          candidates: aiCandidates.map((candidate) => candidate.text),
        });
        const aiMatch = await disambiguator({
          kind: "station",
          stationSubtype,
          desired: city,
          candidates: aiCandidates,
          product,
        });
        const pickedIndex = aiMatch?.pickedText
          ? texts.findIndex((text, index) => text === aiMatch.pickedText && !disableds[index])
          : -1;
        if (pickedIndex >= 0) {
          logInfo("[handleAirportTrainModal] AI 兜底选中", {
            stationSubtype,
            desired: city,
            picked: texts[pickedIndex],
            reasoning: aiMatch.reasoning,
          });
          await options.nth(pickedIndex).click({ force: true });
          await delay(500);
          return { matched: true, source: "ai", text: texts[pickedIndex], reasoning: aiMatch.reasoning };
        }
        logWarn("[handleAirportTrainModal] AI 未返回可点击候选", {
          stationSubtype,
          desired: city,
          pickedText: aiMatch?.pickedText ?? null,
        });
      } catch (err) {
        logWarn("[handleAirportTrainModal] AI 兜底失败，回退到第一可用项", {
          stationSubtype,
          err: String(err.message || err),
        });
      }
    }
    const fallbackIndex = usableIndexes[0];
    await options.nth(fallbackIndex).click({ force: true }).catch(() => {});
    await delay(500);
    return { matched: true, source: "fallback-first", text: texts[fallbackIndex] };
  }

  const airportResult = await selectField(0, "airport", [`${city}机场`, `${city}国际机场`]);
  logInfo("[handleAirportTrainModal] airport", JSON.stringify(airportResult));
  const trainResult = await selectField(1, "train", [city, `${city}站`, `${city}南站`, `${city}北站`, `${city}东站`, `${city}西站`]);
  logInfo("[handleAirportTrainModal] train", JSON.stringify(trainResult));
  await delay(500);
  const confirm = modal.getByRole("button", { name: "确定", exact: true });
  if ((await confirm.count()) === 0) {
    logWarn("[handleAirportTrainModal] 未找到\"确定\"按钮");
    return false;
  }
  await confirm.first().click({ force: true });
  await delay(2_000);
  return true;
}


export {
  fillPickupAndDropoff,
  handleAirportTrainModal,
};
