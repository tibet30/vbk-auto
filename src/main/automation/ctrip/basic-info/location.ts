// @ts-nocheck
/**
 * 基本信息面板里「城市 / 产品线」类下拉的写入：
 *   - fillCitySelect：在 div[id=${id}] 的选择框里按城市 + preferredCountry 精确挑选项；
 *     没有精确匹配时使用注入的 disambiguator（AI）做兜底消歧，但绝不回退到「其它国家同名城市」；
 *   - fillProductLine：按「目的地一地 / 省份一地」白名单尝试选择；未命中则跳过。
 * 顶部带 `// @ts-nocheck`，page 是动态传入。
 */

import { delay, assertCount, readLocatorSnapshot, getControlledDropdownOptions, clickLocatorSnapshotOption } from "../utils.js";
import { matchDropdownOption } from "../../dropdown-match.js";
import { pickCityOption } from "./types.js";
import { logInfo } from "../../../../shared/log-timestamp.js";

const CITY_SEARCH_TIMEOUT_MS = 3_000;
const CITY_OPTION_SETTLE_MS = 400;

/**
 * 通用城市下拉选择器：处理「已选即跳过」「清除 → 重选」「打开搜索框 → 输 → 轮询候选」流程；
 * 命中失败时按 preferredCountry / ambiguous / missing 给出对应错误，preferredCountry 场景下
 * 拒绝回退到其它同名国家。AI 消歧仅在 disambiguator 注入并匹配 kind 时启用。
 */
export async function fillCitySelect(page, id, city, preferredCountry, extra = {}) {
  const disambiguator = extra?.disambiguator;
  const product = extra?.product ?? {};
  const select = page.locator(`div[id="${id}"]`);
  await assertCount(select, 1, `${city}城市选择器`);

  const selectedValue = select.locator(".ant-select-selection-selected-value");
  if (await selectedValue.count()) {
    const selectedText = (
      (await selectedValue.getAttribute("title")) ||
      (await selectedValue.innerText().catch(() => ""))
    ).trim();
    const verdict = pickCityOption([selectedText], city, preferredCountry);
    if (verdict.kind === "matched") return;

    if (selectedText) {
      const clear = select.locator(".ant-select-selection__clear");
      try {
        await select.hover();
        await assertCount(clear, 1, `${city}城市清除按钮`);
        await clear.click();
        await selectedValue.waitFor({ state: "hidden", timeout: 3_000 });
      } catch {
        throw new Error(`无法清除已选城市：${selectedText}`);
      }
    }
  }

  const selection = select.locator(".ant-select-selection");
  await assertCount(selection, 1, `${city}城市可见选择框`);
  await selection.click();

  const input = select.locator("input.ant-select-search__field");
  await assertCount(input, 1, `${city}城市输入框`);
  try {
    await input.waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    await selection.click();
    await input.waitFor({ state: "visible", timeout: 5_000 });
  }
  // 这个远程搜索框不会丢弃旧关键词的迟到响应。逐字输入会同时发出“北”与“北京”
  // 等请求，较慢的单字响应可能最后覆盖完整城市结果；一次 fill 只触发完整关键词请求。
  await input.fill(city);

  const options = await getControlledDropdownOptions(page, selection);
  const commitCityOption = async (expected) => {
    if (!(await clickLocatorSnapshotOption(options, expected))) return false;
    const commitDeadline = Date.now() + 2_000;
    while (Date.now() < commitDeadline) {
      const committed = await readLocatorSnapshot(selectedValue);
      const text = committed[0]?.title || committed[0]?.text || "";
      if (pickCityOption([text], city, preferredCountry).kind === "matched") return true;
      await delay(100);
    }
    return false;
  };
  const deadline = Date.now() + CITY_SEARCH_TIMEOUT_MS;
  let lastSeen: string[] = [];
  let lastSnapshot = [];
  let lastDecision: ReturnType<typeof pickCityOption> = { kind: "missing", seen: [], reason: "notFound" };
  let stableMatchKey = "";
  let stableMatchSince = 0;
  let stableMatchReady = false;
  while (Date.now() < deadline) {
    const snapshot = await readLocatorSnapshot(options);
    lastSnapshot = snapshot;
    const labels = snapshot.map(({ nameTitle, title, text }) => {
      // VBK 的城市行会同时展示「中国-西安」和所属省份「中国-陕西」；
      // 外层 title / innerText 可能把两列拼成一个字符串，结构化的 .Name title
      // 才是可点击城市本身。优先读取它，避免把确定候选误送给 90s AI 消歧。
      return nameTitle || title || text;
    });
    lastSeen = labels.filter(Boolean);
    lastDecision = pickCityOption(labels, city, preferredCountry);
    if (lastDecision.kind === "matched") {
      const matchKey = labels[lastDecision.index] || "";
      if (matchKey !== stableMatchKey) {
        stableMatchKey = matchKey;
        stableMatchSince = Date.now();
      } else if (Date.now() - stableMatchSince >= CITY_OPTION_SETTLE_MS) {
        stableMatchReady = true;
        break;
      }
    } else {
      // 输入后可能短暂显示上一次查询结果，随后出现 Not Found，再到达真正
      // 的远程响应。任一中间态都要重置稳定计时，不能点击也不能提前失败。
      stableMatchKey = "";
      stableMatchSince = 0;
    }
    await delay(100);
  }
  if (lastDecision.kind !== "matched" || !stableMatchReady) {
    const canAiDisambiguate = disambiguator
      && (lastDecision.kind === "ambiguous"
        || (lastDecision.kind === "missing" && lastSeen.length > 0));
    if (canAiDisambiguate) {
      const candidates = lastSeen.map((text, i) => ({ index: i, text, id: String(i) }));
      const aliases = preferredCountry
        ? [`${preferredCountry}-${city}`, city, `${city}市`, `${preferredCountry}-${city}市`]
        : [city, `${city}市`];
      const ai = await matchDropdownOption(
        candidates,
        candidates.map(() => false),
        aliases,
        { kind: "city", desired: city, product, description: `${city}城市` },
        disambiguator,
      );
      if (ai) {
        const idx = lastSeen.findIndex((t) => t === ai.text);
        if (idx >= 0) {
          if (ai.source === "ai") {
            logInfo("[fillCitySelect] AI 兜底选中城市", {
              desired: city,
              picked: ai.text,
              reasoning: ai.reasoning,
            });
          }
          const clicked = await commitCityOption(lastSnapshot[idx]);
          if (clicked) return;
        }
      }
    }
    const alternatives = lastSeen.join("、") || "无";
    if (preferredCountry) {
      throw new Error(
        `${city}城市下拉未找到「${preferredCountry}-${city}」精确选项，禁止回退到其它国家同名城市；可选：${alternatives}`,
      );
    }
    if (lastDecision.kind === "ambiguous") {
      throw new Error(
        `${city}城市下拉存在多个候选，无法默认选择其一；可选：${lastDecision.labels.join("、") || alternatives}`,
      );
    }
    throw new Error(`${city}城市下拉未找到精确选项；可选：${alternatives}`);
  }
  const clicked = await commitCityOption(lastSnapshot[lastDecision.index]);
  if (!clicked) throw new Error(`${city}城市候选点击后未形成已选值，请重试。`);
}

/**
 * 产品线下拉写入：候选按目的地 / 省份拼 `${city/省}一地`，命中即返回；
 *   - 已选值相符则跳过；
 *   - 不退回默认第一项，避免错选；
 *   - 未找到候选时只记录并跳过：产品线不是自动录入硬阻断项。
 */
export async function fillProductLine(page, destinationCity, province) {
  const provinceBase = String(province || "")
    .trim()
    .replace(/(维吾尔自治区|壮族自治区|回族自治区|特别行政区|自治区|省|市)$/g, "");
  const candidates = [...new Set([
    `${String(destinationCity || "").trim()}一地`,
    `${provinceBase}一地`,
  ].filter((value) => value !== "一地"))];
  if (!candidates.length) {
    logInfo("[fillProductLine] skipped: empty candidates");
    return;
  }

  const scope = page.locator('div[id="baseInfo.productLineID"]');
  const scopeCount = await scope.count().catch(() => 0);
  if (scopeCount !== 1) {
    logInfo("[fillProductLine] skipped: product line control not found", { scopeCount });
    return;
  }
  const selectedValue = scope.locator(".ant-select-selection-selected-value");
  if (await selectedValue.count()) {
    const selectedText = (
      (await selectedValue.getAttribute("title")) ||
      (await selectedValue.innerText().catch(() => ""))
    ).trim();
    if (candidates.includes(selectedText)) return;
  }

  const selection = scope.locator(".ant-select-selection");
  const selectionCount = await selection.count().catch(() => 0);
  if (selectionCount !== 1) {
    logInfo("[fillProductLine] skipped: selection not found", { selectionCount });
    return;
  }
  const options = await getControlledDropdownOptions(page, selection);
  const deadline = Date.now() + 3_000;
  let seen: string[] = [];
  while (Date.now() < deadline) {
    await selection.click();
    await delay(400);
    const snapshot = await readLocatorSnapshot(options);
    seen = snapshot.map((option) => option.text);
    const disableds = snapshot.map((option) =>
      /ant-select-item-disabled|ant-select-dropdown-menu-item-disabled/.test(option.className));
    const matchIndex = seen.findIndex(
      (text, index) => candidates.includes(text) && !disableds[index],
    );
    if (matchIndex >= 0) {
      if (matchIndex === 0) {
        logInfo("[fillProductLine] skipped: matched first option", { matched: seen[matchIndex], seen: seen.join("、") });
        return;
      }
      const clicked = await clickLocatorSnapshotOption(options, snapshot[matchIndex]);
      if (!clicked) {
        await delay(150);
        continue;
      }
      const commitDeadline = Date.now() + 2_000;
      while (Date.now() < commitDeadline) {
        const committed = await readLocatorSnapshot(selectedValue);
        const committedText = committed[0]?.title || committed[0]?.text || "";
        if (candidates.includes(committedText)) return;
        await delay(100);
      }
      logInfo("[fillProductLine] skipped: matched option did not commit", { matched: seen[matchIndex] });
      return;
    }
    const realOptions = seen.filter(
      (text, index) => text && !["暂无数据", "Not Found"].includes(text) && !disableds[index],
    );
    if (realOptions.length) {
      logInfo("[fillProductLine] skipped: no matching optional product line", {
        candidates: candidates.join("、"),
        options: realOptions.join("、"),
      });
      return;
    }
    await page.keyboard.press("Escape").catch(() => {});
    await delay(350);
  }
  logInfo("[fillProductLine] skipped: product line options timeout", { seen: seen.filter(Boolean).join("、") || "无" });
}

// source-slicing anchor（仅供测试切片识别；真实实现见 ./tabs.ts）：
/**
 * 测试切片占位：实现见 ../tabs.ts；保留签名让 source-slicing 识别 basic-info/location 这一段。
 */
export async function openProductEditor(page, productId, options = {}) {
  void page; void productId; void options;
  throw new Error("openProductEditor sentinel in basic-info/location.ts; runtime uses tabs.ts implementation");
}
