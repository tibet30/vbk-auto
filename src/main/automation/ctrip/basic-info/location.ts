// @ts-nocheck
/**
 * 基本信息面板里「城市 / 产品线」类下拉的写入：
 *   - fillCitySelect：在 div[id=${id}] 的选择框里按城市 + preferredCountry 精确挑选项；
 *     没有精确匹配时使用注入的 disambiguator（AI）做兜底消歧，但绝不回退到「其它国家同名城市」；
 *   - fillProductLine：按「目的地一地 / 省份一地」白名单从产品线下拉里挑，禁止退到默认第一项。
 * 顶部带 `// @ts-nocheck`，page 是动态传入。
 */

import { delay, assertCount } from "../utils.js";
import { matchDropdownOption } from "../../dropdown-match.js";
import { pickCityOption } from "./types.js";
import { logInfo } from "../../../../shared/log-timestamp.js";

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

  const options = page.locator(
    ".ant-select-dropdown:not(.ant-select-dropdown-hidden) li[role=option]",
  );
  const deadline = Date.now() + 8_000;
  let lastSeen: string[] = [];
  let lastDecision: ReturnType<typeof pickCityOption> = { kind: "missing", seen: [], reason: "notFound" };
  while (Date.now() < deadline) {
    const count = await options.count();
    const labels: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const option = options.nth(index);
      const title = ((await option.getAttribute("title")) || "").trim();
      const nameTitle = ((await option.locator(".Name[title]").getAttribute("title").catch(() => null)) || "").trim();
      labels.push(title || nameTitle || ((await option.innerText().catch(() => ""))).trim());
    }
    lastSeen = labels.filter(Boolean);
    lastDecision = pickCityOption(labels, city, preferredCountry);
    if (lastDecision.kind === "matched") break;
    await delay(250);
  }
  if (lastDecision.kind !== "matched") {
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
          await options.nth(idx).click();
          return;
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
  await options.nth(lastDecision.index).click();
}

/**
 * 产品线下拉写入：候选按目的地 / 省份拼 `${city/省}一地`，命中即返回；
 *   - 已选值相符则跳过；
 *   - 命中且 enabled 索引为 0 时抛错（避免错选默认项）；
 *   - 10s 内未拿到非空候选抛错。
 */
export async function fillProductLine(page, destinationCity, province) {
  const provinceBase = String(province || "")
    .trim()
    .replace(/(维吾尔自治区|壮族自治区|回族自治区|特别行政区|自治区|省|市)$/g, "");
  const candidates = [...new Set([
    `${String(destinationCity || "").trim()}一地`,
    `${provinceBase}一地`,
  ].filter((value) => value !== "一地"))];
  if (!candidates.length) throw new Error("产品线缺少目的城市和省份，无法自动选择。");

  const scope = page.locator('div[id="baseInfo.productLineID"]');
  await assertCount(scope, 1, "产品线容器 div#baseInfo.productLineID");
  const selectedValue = scope.locator(".ant-select-selection-selected-value");
  if (await selectedValue.count()) {
    const selectedText = (
      (await selectedValue.getAttribute("title")) ||
      (await selectedValue.innerText().catch(() => ""))
    ).trim();
    if (candidates.includes(selectedText)) return;
  }

  const selection = scope.locator(".ant-select-selection");
  await assertCount(selection, 1, "产品线可见选择框");
  const options = page.locator(
    ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option, " +
    ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-dropdown-menu-item",
  );
  const deadline = Date.now() + 10_000;
  let seen: string[] = [];
  while (Date.now() < deadline) {
    await selection.click();
    await delay(400);
    const total = await options.count();
    seen = total ? (await options.allTextContents()).map((text) => text.trim()) : [];
    const disableds = await Promise.all(
      Array.from({ length: total }, async (_, index) => {
        const cls = (await options.nth(index).getAttribute("class")) || "";
        return /ant-select-item-disabled|ant-select-dropdown-menu-item-disabled/.test(cls);
      }),
    );
    const matchIndex = seen.findIndex(
      (text, index) => candidates.includes(text) && !disableds[index],
    );
    if (matchIndex >= 0) {
      if (matchIndex === 0) {
        throw new Error(
          `产品线命中候选"${seen[matchIndex]}"但其为默认第一项，必须按 candidates 精匹配后点击；可选：${seen.join("、")}`,
        );
      }
      await options.nth(matchIndex).click();
      await delay(300);
      return;
    }
    const realOptions = seen.filter(
      (text, index) => text && !["暂无数据", "Not Found"].includes(text) && !disableds[index],
    );
    if (realOptions.length) {
      throw new Error(`产品线未找到"${candidates.join("或")}"；可选：${realOptions.join("、")}`);
    }
    await page.keyboard.press("Escape").catch(() => {});
    await delay(350);
  }
  throw new Error(`产品线下拉在 10 秒内未返回可用选项；最后看到：${seen.filter(Boolean).join("、") || "无"}`);
}

// source-slicing anchor（仅供测试切片识别；真实实现见 ./tabs.ts）：
/**
 * 测试切片占位：实现见 ../tabs.ts；保留签名让 source-slicing 识别 basic-info/location 这一段。
 */
export async function openProductEditor(page, productId, options = {}) {
  void page; void productId; void options;
  throw new Error("openProductEditor sentinel in basic-info/location.ts; runtime uses tabs.ts implementation");
}
