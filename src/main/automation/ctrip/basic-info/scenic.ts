// @ts-nocheck
/**
 * 「基本信息 → 国家景区」面板里省份 / 景点的自动填写：
 *   - fillScenicAreaProvince：在 #scenic_area 的省份下拉按白名单 suffix 规范化标签名后挑选，
 *     必要时回退到 AI disambiguator；
 *   - fillScenicAreaSpots：依次按景点 / 景区级挑选，命中后点「添加」，并轮询确认标签写入；
 *   - 数据风险弹窗（境外同名项）由 dismissDataRiskDialog 关闭，命中会丢弃该条以避免写入脏数据。
 * 顶部带 `// @ts-nocheck`，page 是动态传入。
 */

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

  /**
   * 拉出当前打开的 .ant-select-dropdown 候选 + enabled 状态，过滤掉空 / 占位项，
   * 等到至少有一项可用就 return；最多等 8s。
   */
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

/**
 * 按省级 + 景点数组，依次在「景点 → 城市/景区」两个级联下拉里挑选项；命中后点「添加」并
 * 轮询确认标签被写入 #scenic_area。任何一步失败 / 触发数据风险弹窗都记录到 logs 而不抛错。
 */
export async function fillScenicAreaSpots(page, province, spots, logs = [], extra = {}) {
  const disambiguator = extra?.disambiguator;
  const product = extra?.product ?? {};
  const container = page.locator("#scenic_area");
  await assertCount(container, 1, "国家景区容器 #scenic_area");
  const provinceLabel = (province || "").trim();
  if (!provinceLabel) return;
  const seen = new Set();
  // 只计入本次确认新增的标签：历史已有、下拉未命中和风险弹窗都不占名额。
  let newlyAddedCount = 0;

  const options = page.locator(
    ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option, " +
    ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-dropdown-menu-item",
  );
  const optionLabel = (text) => String(text || "").split(/\r?\n/)[0].trim();
  const normalizeCommittedLabel = (text) => String(text || "").replace(/\s+/g, "");
  const committedChoiceSelector = ".ant-select-selection__choice, .ant-select-selection-item";
  const readCommittedLabels = async () => {
    const tags = (await container.locator(".ant-tag").allTextContents()).map(normalizeCommittedLabel);
    const choices = container.locator(committedChoiceSelector);
    const choiceLabels = await Promise.all(
      Array.from({ length: await choices.count() }, async (_, index) => {
        const choice = choices.nth(index);
        const title = (await choice.getAttribute("title")) || "";
        const visibleText = await choice.innerText().catch(() => "");
        return normalizeCommittedLabel(title || visibleText);
      }),
    );
    return [...tags, ...choiceLabels].filter(Boolean);
  };
  // 读取 4 个级联 combobox 当前选择值（未提交）：用于排除，避免「第四级
  // combobox 当前显示 X」被误识别为「已添加标签 X」。覆盖 VBK 真实渲染：
  //   - .ant-select-selection-selected-value（旧版/部分容器）
  //   - .ant-select-selection-item（cascade 当前值常见渲染）
  // 两个类任一命中即视为未提交，不计入 committedLabels。
  const readCascadeCurrentValues = async (comboboxes) => {
    const exclude = new Set();
    const cascadeTotal = await comboboxes.count();
    for (let index = 0; index < cascadeTotal; index += 1) {
      const cb = comboboxes.nth(index);
      const selectors = [
        ".ant-select-selection-selected-value",
        ".ant-select-selection-item",
      ];
      for (const selector of selectors) {
        const sel = cb.locator(selector);
        const hits = await sel.count();
        for (let hit = 0; hit < hits; hit += 1) {
          const node = sel.nth(hit);
          const title = (await node.getAttribute("title")) || "";
          const inner = await node.innerText().catch(() => "");
          const text = normalizeCommittedLabel(title || inner).trim();
          if (text) exclude.add(text);
        }
      }
    }
    return exclude;
  };
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

  // 国家景区的「页面已提交景点总数」必须 ≤ 3。计算口径：
  //   - 只看 #scenic_area 容器内的 .ant-tag / 已落定的 choice 文本；
  //   - 排除 4 个级联 combobox 当前未提交选择值（不算已添加）；
  //   - 排除省份标签。省份在 VBK 中可能渲染为「陕西」「陕西(中国)」「陕西（中国）」
  //     「陕西省(中国)」等多种形状；必须用传入的 province 参数主动构造白名单再
  //     排除，不能仅靠括号判定 —— 仅按括号的判定会把「陕西(中国)」误计为景点。
  //   - 必须实时刷新：每个候选开始前 / 点击「添加」前重新读一次，达到 3 立即停止，
  //     避免前一轮循环写入后遗漏的标签被新候选重复填入。
  // 已有 ≥ 3 个景点 → 不进入搜索/添加循环，原样返回。
  // 已有 N < 3 → 本次最多新增 (3 - N) 项，避免页面被填爆。
  const provinceBaseNorm = normalizeCommittedLabel(
    provinceLabel.replace(/(维吾尔自治区|壮族自治区|回族自治区|特别行政区|自治区|省|市)$/g, ""),
  );
  const provinceFullNorm = normalizeCommittedLabel(provinceLabel);
  const countryNorm = normalizeCommittedLabel("中国");
  // 省份在 VBK 中可能以多种形态出现：传入「陕西」时页面标签可能是「陕西」
  // 「陕西(中国)」「陕西（中国）」「陕西省(中国)」。必须主动追加“省 / 市”后缀
  // 变体，仅靠括号判定会算「陕西(中国)」为景点。
  const provinceNameCandidates = new Set<string>();
  for (const prov of [provinceBaseNorm, provinceFullNorm]) {
    if (!prov) continue;
    provinceNameCandidates.add(prov);
    if (!/(维吾尔自治区|壮族自治区|回族自治区|特别行政区|自治区|省|市)$/.test(prov)) {
      provinceNameCandidates.add(`${prov}省`);
      provinceNameCandidates.add(`${prov}市`);
    }
  }
  const provinceShapes = new Set<string>();
  for (const prov of provinceNameCandidates) {
    provinceShapes.add(prov);
    provinceShapes.add(`${prov}(${countryNorm})`);
    provinceShapes.add(`${prov}（${countryNorm}）`);
    provinceShapes.add(`${prov}/${countryNorm}`);
    provinceShapes.add(`${prov}(国家)`);
    provinceShapes.add(`${prov}（国家）`);
  }
  const isProvinceShapeLabel = (text) => provinceShapes.has(text);

  const readCommittedSpotCount = async () => {
    const cbs = container.getByRole("combobox");
    const cascadeCurrent = await readCascadeCurrentValues(cbs);
    return (await readCommittedLabels())
      .filter((text) => !cascadeCurrent.has(text))
      .filter((text) => !isProvinceShapeLabel(text))
      .length;
  };
  const initialCommittedCount = await readCommittedSpotCount();
  if (initialCommittedCount >= 3) {
    logs.push(`[info] 国家景区已提交 ${initialCommittedCount} 项（≥ 3），本次不再搜索 / 添加`);
    return;
  }
  logs.push(`[info] 国家景区已提交 ${initialCommittedCount} 项，本次最多新增 ${Math.max(0, 3 - initialCommittedCount)} 项`);

  for (const raw of spots) {
    // 实时刷新：每个候选开始前重新读取，避免前几轮填入后总数实际已到 3 但本轮仍继续。
    let liveCommittedCount = await readCommittedSpotCount();
    if (liveCommittedCount >= 3) {
      logs.push(`[info] 国家景区已提交 ${liveCommittedCount} 项（≥ 3），停止后续候选`);
      break;
    }
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
    const normalizedAliases = spotAliases.map((name) => normalizeCommittedLabel(name));
    const comboboxes = container.getByRole("combobox");
    const total = await comboboxes.count();
    if (total < 4) {
      throw new Error(`国家景区级联下拉结构异常：预期国家/省/城市景区/景点四级，实际 ${total}`);
    }
    const hasSpotText = (text) => normalizedAliases.some((name) => text.includes(name));
    // 把已提交标签/choice 与 4 个级联 combobox 当前未提交选择值分开：级联当前
    // 选择只是「选了下拉但还没点添加」的状态，不算已添加；漏掉这一步会让
    // 第四级显示「西安明城墙」时把同名点全部误判为已存在。
    const cascadeCurrentValues = await readCascadeCurrentValues(comboboxes);
    const committedLabels = (await readCommittedLabels())
      .filter((text) => !cascadeCurrentValues.has(text))
      .filter((text) => !isProvinceShapeLabel(text));
    const taggedSpotExists = committedLabels.some((tag) => normalizedAliases.some((name) =>
      tag === name || tag.startsWith(`${name}(`) || tag.startsWith(`${name}（`),
    ));
    if (taggedSpotExists) {
      logs.push(`[info] 景点"${spot}"已存在于国家景区标签，未计入本次新增名额`);
      continue;
    }

    let selected = await chooseExact(comboboxes.nth(3), spot, spotAliases, "景点");
    if (!selected) {
      selected = await chooseExact(comboboxes.nth(2), spot, spotAliases, "城市/景区（景区）");
    }
    if (!selected) {
      logs.push(`[warn] 景点或景区"${spot}"均未找到精确选项，已跳过`);
      continue;
    }
    // 点击「添加」前再读一次实时总数：上一步选下拉可能耗时较长，期间
    // 其他写入可能让页面已满；达到 3 必须立刻停止，避免越界。
    liveCommittedCount = await readCommittedSpotCount();
    if (liveCommittedCount >= 3) {
      logs.push(`[info] 国家景区已提交 ${liveCommittedCount} 项（≥ 3），停止添加`);
      break;
    }
    const addButton = container.getByRole("button", { name: "添加", exact: true }).first();
    if (!(await addButton.count())) {
      logs.push(`[warn] 景点"${spot}"已选择但未找到「添加」按钮，已跳过`);
      continue;
    }
    await addButton.click();
    const dataRisk = await dismissDataRiskDialog(page);
    if (dataRisk) {
      logs.push(`[warn] 景点"${spot}"添加触发数据风险弹窗（${dataRisk}），疑似境外同名项，已跳过该景点`);
      await page.keyboard.press("Escape").catch(() => {});
      await delay(200);
      continue;
    }
    const commitDeadline = Date.now() + 8_000;
    let committed = false;
    let delayedDataRisk = null;
    while (Date.now() < commitDeadline) {
      // 提交成功后级联应已复位为 placeholder，cascadeCurrentValues 多半为空；
      // 仍过滤以防 VBK 把保留值留在 combobox 内被误判。
      const polledLabels = (await readCommittedLabels())
        .filter((text) => !cascadeCurrentValues.has(text));
      if (hasSpotText(polledLabels.join(""))) {
        committed = true;
        break;
      }
      delayedDataRisk = await dismissDataRiskDialog(page, 200);
      if (delayedDataRisk) break;
      await delay(200);
    }
    if (!committed) {
      if (delayedDataRisk) {
        logs.push(`[warn] 景点"${spot}"提交后弹出数据风险弹窗（${delayedDataRisk}），已跳过该景点`);
        continue;
      }
      const again = await dismissDataRiskDialog(page, 500);
      if (again) {
        logs.push(`[warn] 景点"${spot}"提交后弹出数据风险弹窗（${again}），已跳过该景点`);
        continue;
      }
      throw new Error(`景点“${spot}”已选择但未成功添加到国家景区标签`);
    }
    newlyAddedCount += 1;
    // 添加确认后再读一次实时总数 —— 页面可能因为 VBK 的同步在 poll 之外又补了同名标签，
    // 用真实总数写日志才能反映“3/3”而不是“1/3”。
    const finalCommittedCount = await readCommittedSpotCount();
    logs.push(`[info] 景点"${spot}"已成功新增到国家景区标签（${finalCommittedCount}/3）`);
  }
}

// source-slicing anchor（仅供测试切片识别；内部不调用）：
/**
 * 测试切片占位：保留这个 noop 函数让 source-slicing 工具识别 scenic 相关代码段。
 */
async function _scenicSliceAnchor() { void 0; }
