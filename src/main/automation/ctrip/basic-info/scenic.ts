// @ts-nocheck

import { delay, assertCount, pickSearchInput } from "../utils.js";
import { matchDropdownOption } from "../../dropdown-match.js";
import { findProvinceOptionIndex } from "../../schema/schema-functions.js";
import { dismissDataRiskDialog } from "../dialogs.js";

export async function fillScenicAreaProvince(page, province, extra = {}) {
  const disambiguator = extra?.disambiguator;
  const product = extra?.product ?? {};
  const label = (province || "").trim();
  if (!label) throw new Error("国家景区（省份）未配置，无法继续录入。");
  const container = page.locator("#scenic_area");
  await assertCount(container, 1, "国家景区容器 #scenic_area");
  const provinceBase = label.replace(/(维吾尔自治区|壮族自治区|回族自治区|特别行政区|自治区|省|市)$/g, "");
  const addedTags = (await container.locator(".ant-tag").allTextContents())
    .map((text) => text.replace(/\s+/g, ""));
  if (addedTags.some((text) => text.includes(provinceBase))) return;
  const comboboxes = container.getByRole("combobox");
  const comboboxCount = await comboboxes.count();
  if (comboboxCount < 2) {
    throw new Error(`国家景区级联下拉结构异常：仅找到 ${comboboxCount} 个下拉框`);
  }
  const optionNodes = page.locator(
    ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option, " +
    ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-dropdown-menu-item",
  );

  async function availableOptions(description) {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const total = await optionNodes.count();
      if (total) {
        const texts = (await optionNodes.allTextContents()).map((text) => text.trim());
        const disableds = await Promise.all(
          Array.from({ length: total }, async (_, index) => {
            const cls = (await optionNodes.nth(index).getAttribute("class")) || "";
            return /ant-select-item-disabled|ant-select-dropdown-menu-item-disabled/.test(cls);
          }),
        );
        if (texts.some((text, index) => text && text !== "Not Found" && !disableds[index])) {
          return { texts, disableds };
        }
      }
      await delay(250);
    }
    throw new Error(`${description}下拉未返回可用选项。`);
  }

  await comboboxes.nth(1).click();
  const provinceSearch = await pickSearchInput(comboboxes.nth(1), "省份搜索输入框");
  await provinceSearch.fill("");
  await provinceSearch.type(label, { delay: 80 });
  const provinces = await availableOptions("省份");
  const texts = provinces.texts;
  const disableds = provinces.disableds;
  const candidates = texts.map((text, i) => ({ index: i, text, id: undefined }));
  const localIndex = findProvinceOptionIndex(texts, label);
  let chosenIndex = localIndex >= 0 && !disableds[localIndex] ? localIndex : -1;
  let chosenSource = "exact";
  if (chosenIndex < 0) {
    const ai = await matchDropdownOption(
      candidates,
      disableds,
      [label, `${label}省`, `${label}市`, `${label}自治区`],
      { kind: "province", desired: label, product, description: "省份" },
      disambiguator,
    );
    if (ai) {
      chosenIndex = ai.index;
      chosenSource = ai.source;
      if (ai.source === "ai") {
        console.info("[fillScenicAreaProvince] AI 兜底选中省份", {
          desired: label,
          picked: ai.text,
          reasoning: ai.reasoning,
        });
      }
    }
  }
  if (chosenIndex < 0) {
    throw new Error(`省下拉未找到「${label}」；可选：${texts.filter(Boolean).join("、") || "无"}`);
  }
  void chosenSource;
  await optionNodes.nth(chosenIndex).click();
  await delay(300);
  const addButton = container.getByRole("button", { name: "添加", exact: true }).first();
  if (await addButton.count()) {
    const alreadyAdded = await container.getByText(label, { exact: true }).count();
    if (alreadyAdded <= 1) await addButton.click();
  }
  const dataRisk = await dismissDataRiskDialog(page);
  if (dataRisk) {
    throw new Error(
      `省下拉疑似选中了境外项：${dataRisk}。这是 VBK 的阻断式反馈，请检查 VBK 中是否手动选过其他国家的省份。`,
    );
  }
  await delay(300);
}

export async function fillScenicAreaSpots(page, province, spots, logs = [], extra = {}) {
  const disambiguator = extra?.disambiguator;
  const product = extra?.product ?? {};
  const container = page.locator("#scenic_area");
  await assertCount(container, 1, "国家景区容器 #scenic_area");
  const provinceLabel = (province || "").trim();
  if (!provinceLabel) return;
  const seen = new Set();

  const options = page.locator(
    ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option, " +
    ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-dropdown-menu-item",
  );
  const optionLabel = (text) => String(text || "").split(/\r?\n/)[0].trim();
  const chooseExact = async (combobox, target, aliases, description) => {
    const selected = combobox.locator(".ant-select-selection-selected-value");
    if (await selected.count()) {
      const current = ((await selected.getAttribute("title")) || (await selected.innerText().catch(() => ""))).trim();
      if (aliases.includes(current)) return true;
    }
    await combobox.click();
    const search = await pickSearchInput(combobox, `${description}搜索输入框`);
    await search.fill("");
    await search.type(target, { delay: 80 });
    const deadline = Date.now() + 8_000;
    let last: string[] = [];
    let lastDisableds: boolean[] = [];
    while (Date.now() < deadline) {
      const count = await options.count();
      last = count ? await Promise.all(
        Array.from({ length: count }, async (_, index) => optionLabel(
          await options.nth(index).innerText().catch(() => ""),
        )),
      ) : [];
      lastDisableds = await Promise.all(Array.from({ length: count }, async (_, index) => {
        const cls = (await options.nth(index).getAttribute("class")) || "";
        return /ant-select-item-disabled|ant-select-dropdown-menu-item-disabled/.test(cls);
      }));
      const matchIndex = last.findIndex((text, index) => aliases.includes(text) && !lastDisableds[index]);
      if (matchIndex >= 0) {
        await options.nth(matchIndex).click();
        await delay(300);
        return true;
      }
      await delay(250);
    }
    if (disambiguator) {
      const candidates = last.map((text, index) => ({ index, text }));
      const ai = await matchDropdownOption(
        candidates,
        lastDisableds,
        aliases,
        { kind: "spot", desired: target, product, description },
        disambiguator,
      );
      if (ai) {
        await options.nth(ai.index).click();
        await delay(300);
        if (ai.source === "ai") {
          console.info("[fillScenicAreaSpots] AI 兜底选中景点", {
            desired: target,
            picked: ai.text,
            reasoning: ai.reasoning,
          });
        }
        return true;
      }
    }
    await page.keyboard.press("Escape").catch(() => {});
    return false;
  };

  for (const raw of spots) {
    if (typeof raw !== "string") continue;
    const spot = raw.trim();
    if (!spot) continue;
    if (seen.has(spot)) continue;
    seen.add(spot);
    const spotAliases = [
      spot,
      `${spot}博物馆`,
      spot.replace(/[（(].*?[）)]/g, ""),
      ...Array.from(spot.matchAll(/[（(]([^）)]+)[）)]/g), (match) => match[1]),
    ].map((value) => value.trim()).filter(Boolean);
    const existingText = (await container.innerText()).replace(/\s+/g, "");
    if (spotAliases.some((name) => existingText.includes(`${name.replace(/\s+/g, "")}(`))) continue;
    const comboboxes = container.getByRole("combobox");
    const total = await comboboxes.count();
    if (total < 4) {
      throw new Error(`国家景区级联下拉结构异常：预期国家/省/城市景区/景点四级，实际 ${total}`);
    }

    let selected = await chooseExact(comboboxes.nth(3), spot, spotAliases, "景点");
    if (!selected) {
      selected = await chooseExact(comboboxes.nth(2), spot, spotAliases, "城市/景区（景区）");
    }
    if (!selected) {
      logs.push(`[warn] 景点或景区"${spot}"均未找到精确选项，已跳过`);
      continue;
    }
    const addButton = container.getByRole("button", { name: "添加", exact: true }).first();
    if (await addButton.count()) {
      await addButton.click().catch(() => {});
    }
    const dataRisk = await dismissDataRiskDialog(page);
    if (dataRisk) {
      logs.push(`[warn] 景点"${spot}"添加触发数据风险弹窗（${dataRisk}），疑似境外同名项，已跳过该景点`);
      await page.keyboard.press("Escape").catch(() => {});
      await delay(200);
      continue;
    }
    const commitDeadline = Date.now() + 8_000;
    let committed = false;
    while (Date.now() < commitDeadline) {
      const committedText = (await container.innerText()).replace(/\s+/g, "");
      const cityReset = (await comboboxes.nth(2).innerText()).trim() === "城市/景区";
      const spotReset = (await comboboxes.nth(3).innerText()).trim() === "景点";
      const committedName = spotAliases.find((name) =>
        committedText.includes(`${name.replace(/\s+/g, "")}(`),
      );
      if (cityReset && spotReset && committedName) {
        committed = true;
        break;
      }
      if (await dismissDataRiskDialog(page, 200)) break;
      await delay(200);
    }
    if (!committed) {
      const again = await dismissDataRiskDialog(page, 500);
      if (again) {
        logs.push(`[warn] 景点"${spot}"提交后弹出数据风险弹窗（${again}），已跳过该景点`);
        continue;
      }
      throw new Error(`景点“${spot}”已选择但未成功添加到国家景区标签`);
    }
  }
}

// source-slicing anchor（仅供测试切片识别；内部不调用）：
async function _scenicSliceAnchor() { void 0; }

