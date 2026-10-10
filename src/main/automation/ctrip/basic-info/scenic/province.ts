/**
 * 国家景区（#scenic_area）省份下拉选择。
 *
 * 关键约束：
 *   - 已在 #scenic_area 内存在的省份标签 → 跳过；
 *   - 四个直辖市（VBK PROVINCE 接口不返回）→ 跳过省份，直接录入下级；
 *   - 下拉内必先等 ≥ 1 个可用项再尝试匹配，避免响应迟到；
 *   - 匹配优先级：精确（含 /省/市/自治区 变体）→ AI disambiguate；
 *   - 命中后立即点 + 等待；触发数据风险弹窗 → 视为境外项，硬抛错提示人工核查。
 */

import { assertCount, clickLocatorSnapshotOption, delay, getControlledDropdownOptions, pickSearchInput, readLocatorSnapshot } from "../../utils.js";
import { matchDropdownOption, type Disambiguator } from "../../../dropdown-match.js";
import { findProvinceOptionIndex } from "../../../schema/schema-functions.js";
import { dismissDataRiskDialog } from "../../dialogs.js";
import { logInfo } from "../../../../../shared/log-timestamp.js";
import type { VbkPage } from "../../locator-types.js";
import { DIRECT_ADMIN_MUNICIPALITIES, SCENIC_SEARCH_TIMEOUT_MS } from "./constants.js";

export async function fillScenicAreaProvince(
  page: VbkPage,
  province: string,
  extra: { disambiguator?: Disambiguator; product?: Record<string, unknown> } = {},
): Promise<void> {
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
  // VBK 的 PROVINCE 接口明确不返回四个直辖市；这些目的地直接录入下级景区/景点。
  if (DIRECT_ADMIN_MUNICIPALITIES.has(provinceBase)) return;
  const comboboxes = container.getByRole("combobox");
  const comboboxCount = await comboboxes.count();
  if (comboboxCount < 2) {
    throw new Error(`国家景区级联下拉结构异常：仅找到 ${comboboxCount} 个下拉框`);
  }
  /** 等待当前省份下拉至少出现一个可用项，最多 SCENIC_SEARCH_TIMEOUT_MS。 */
  async function availableOptions(description: string) {
    const deadline = Date.now() + SCENIC_SEARCH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const snapshot = await readLocatorSnapshot(optionNodes);
      if (snapshot.length) {
        const texts = snapshot.map((option) => option.text);
        const disableds = snapshot.map((option) =>
          /ant-select-item-disabled|ant-select-dropdown-menu-item-disabled/.test(option.className));
        if (texts.some((text, index) => text && text !== "Not Found" && !disableds[index])) {
          return { texts, disableds, snapshot };
        }
      }
      await delay(250);
    }
    throw new Error(`${description}下拉未返回可用选项。`);
  }

  await comboboxes.nth(1).click();
  const provinceSearch = await pickSearchInput(comboboxes.nth(1), "省份搜索输入框");
  await provinceSearch.fill(label);
  const optionNodes = await getControlledDropdownOptions(page, comboboxes.nth(1));
  const provinces = await availableOptions("省份");
  const texts = provinces.texts;
  const disableds = provinces.disableds;
  const provinceSnapshot = provinces.snapshot;
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
        logInfo("[fillScenicAreaProvince] AI 兜底选中省份", {
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
  const provinceClicked = await clickLocatorSnapshotOption(optionNodes, provinceSnapshot[chosenIndex]);
  if (!provinceClicked) throw new Error(`省下拉候选「${texts[chosenIndex]}」在提交前已被页面刷新。`);
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