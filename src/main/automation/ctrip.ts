// @ts-nocheck
import { findBestCtripLibraryImage, type CtripLibraryImageAspect } from "./schema.js";
import { breakpoint } from "./debug.js";
import { matchDropdownOption } from "./dropdown-match.js";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ARTIFACTS_DIR,
  PRODUCT_FORM_LABELS,
  PRODUCT_TYPE_LABELS,
  URLS,
  isOnlineStatus,
  isValidStatus,
  productEditorUrl,
  productSectionUrl,
} from "./constants.js";
import {
  findButlerOptionIndex,
  findFirstEnabledOptionIndex,
  findProvinceOptionIndex,
  resolveAdvanceBooking,
  RECOMMENDATION_CATEGORIES,
} from "./schema.js";
import { hotelCandidateMatchesTier, hotelDiamondFromTier } from "../../shared/hotel-tiers.js";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface RecommendationPlanStep {
  index: number;
  category: string;
  text: string;
}

export function buildRecommendationReasonsPlan(
  recommendations: ReadonlyArray<{ category: string; text: string }>,
): RecommendationPlanStep[] {
  if (!Array.isArray(recommendations) || recommendations.length !== 3) {
    throw new Error("推荐理由必须为 3 项，请先在产品草稿中维护。");
  }
  const seen = new Set<string>();
  const plan: RecommendationPlanStep[] = [];
  for (let i = 0; i < 3; i += 1) {
    const item = recommendations[i]!;
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

/**
 * 轮询检查 locator 上的 predicate 直到超时或 true。适用于「点击后等 UI 异步
 * 渲染」的场景，比如：
 *   - 点击 tab 后等待 textarea 出现
 *   - 点击表单控件后等待选项列表出现
 *   - 输入框输入后等待 dropdown 出现
 * 默认上限 3s，间隔 200ms — 兼具反应速度与对 VBK 慢接口的兑底。
 *
 * @param locator 要检查的 Playwright Locator
 * @param predicate 谓词，收到 locator 返回 boolean
 * @param timeoutMs 最长等待，默认 3000
 * @returns {Promise<boolean>} 是否成功达到 predicate === true
 */
async function pollUntil(locator, predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let result = false;
    try {
      result = await predicate(locator);
    } catch {
      result = false;
    }
    if (result) return true;
    await delay(150);
  }
  return predicate(locator).catch(() => false);
}

async function assertCount(locator, expected, description) {
  const count = await locator.count();
  if (count !== expected) {
    throw new Error(`${description}数量异常：期望 ${expected}，实际 ${count}`);
  }
  if (expected > 0) {
    try {
      await locator.first().waitFor({ state: "visible", timeout: 5_000 });
    } catch (error) {
      throw new Error(`${description}可见性等待超时：${(error as Error).message}`);
    }
  }
  return locator;
}

/**
 * 兜底匹配：先用 `aliases` 在已收集的下拉文本里精确查；查不到就让
 * disambiguator 选一个最像的。
 *
 * - `candidates` 顺序对应 optionNodes / options Locator 的 index。
 * - `disableds[i] === true` 跳过该项，精确与 AI 都不要。
 * - 精确匹配走「全文相等」，所以调用方要事先把 prefix / suffix / 大小写
 *   处理掉（fillScenicAreaSpots 的 aliases 已包含「去掉后缀」「加别名」）。
 * - AI 调用只发非 disabled、非空文本的项；AI 返回 pickedText 之后
 *   还要再校验「该文本在原 candidates 里 + 非 disabled」才会采纳，
 *   避免 AI 幻觉点中根本不存在的项。
 * - AI 调用本身 try/catch — 网络报错、key 失效都不拖崩上游。
 * - 返回 null 表示「无匹配」，调用方应跳过该项 / 走原报错路径。
 */
async function selectVisibleOption(page, label) {
  const option = page.getByRole("option", { name: label, exact: true });
  await assertCount(option, 1, `选项“${label}”`);
  await option.click();
}

/**
 * 安全点击：点失败后才走 closeBlockingDialogs 自愈，不再在点之前主动关弹窗。
 * 原因：很多弹窗是 Playwright 自己刚刚点开的（比如“接送站”弹窗），点之前
 * 调 closeBlockingDialogs 会把它们立刻关掉，让后续 click 找不到元素。
 * 错误场景：上一步点击后弹窗未关（例如点击蒙层背后没点中）、或者意外
 * 打开了别的弹窗挡住了目标元素 — Playwright click 超时 30s 后，调用方
 * 再调一次 closeBlockingDialogs 重试。
 *
 * @param page Playwright Page 实例。
 * @param locator 要点的 Locator。
 * @param options Playwright click 选项。
 */
async function safeClick(page, locator, options = {}) {
  try {
    return await locator.click(options);
  } catch (error) {
    const closed = await closeBlockingDialogs(page).catch(() => false);
    if (closed) return await locator.click(options);
    throw error;
  }
}

export async function inspectProductList(page) {
  const addButton = page.locator("a.clego-order-btn").filter({
    hasText: "新增产品",
  });
  await assertCount(addButton, 1, "新增产品入口");

  const rows = page.locator("table tbody tr");
  return {
    url: page.url(),
    title: await page.title(),
    visibleRows: await rows.count(),
    addProductAvailable: await addButton.isVisible(),
  };
}

export async function configureProductShell(page, product) {
  await page.goto(URLS.createSetup, { waitUntil: "domcontentloaded" });
  await page
    .getByRole("button", { name: "下一步", exact: true })
    .waitFor({ state: "visible", timeout: 30_000 });

  let comboboxes = page.getByRole("combobox");
  const initialCount = await comboboxes.count();
  if (initialCount < 3) {
    throw new Error(`创建页下拉框结构异常：仅找到 ${initialCount} 个`);
  }

  await comboboxes.nth(0).click();
  await selectVisibleOption(page, PRODUCT_TYPE_LABELS[product.sales.productType]);

  comboboxes = page.getByRole("combobox");
  await comboboxes.nth(1).click();
  await selectVisibleOption(page, PRODUCT_FORM_LABELS[product.sales.productForm]);

  await page
    .getByRole("combobox")
    .nth(3)
    .waitFor({ state: "visible", timeout: 30_000 });

  if (product.sales.productForm === "groupTour") {
    const splitGroup = page.getByRole("radio", {
      name: product.sales.splitGroup ? "是" : "否",
      exact: true,
    });
    const count = await splitGroup.count();
    if (count >= 1) await splitGroup.first().check();
  }

  return page;
}

export async function createProductShell(page) {
  const nextButton = page.getByRole("button", { name: "下一步", exact: true });
  await assertCount(nextButton, 1, "下一步按钮");
  await nextButton.click();
  // VBK 创建产品后跳转到的页面可以是 baseInfoMerge（旧路径）或其他同
  // 源页面；接受 productId 参数或 /vendor/ 路径段、且 URL 含 productId/
  // productid 参数即可。
  await page.waitForURL(
    (url) => typeof url === "string" && /\/ivbk\/vendor\//.test(url) && /[?&](productid|productId)=\d+/.test(url),
    { timeout: 15_000 },
  );

  const productId = new URL(page.url()).searchParams.get("productId") ||
    new URL(page.url()).searchParams.get("productid");
  if (!productId) throw new Error("携程已进入详情页，但未返回产品 ID");
  return productId;
}

async function fillById(page, id, value, description) {
  const locator = page.locator(`[id="${id}"]`);
  await assertCount(locator, 1, description);
  await locator.fill(String(value));
}

// VBK 远程城市下拉返回的标签是「国家-城市」形式，例如「中国-大同」「朝鲜-大同」。
// 大同在中朝两国都存在同名城市；只按城市名 endsWith 命中第一项会把产品绑到
// 朝鲜-大同，进而触发「中国-大同」未选中的隐藏状态。匹配时必须把国家前缀一起
// 比对，没有指定国家时不允许静默取第一项。
export type CityOptionMatch =
  | { kind: "matched"; index: number; label: string }
  | { kind: "ambiguous"; labels: string[] }
  | { kind: "missing"; seen: string[]; reason: "notFound" | "wrongCountry" };

export function pickCityOption(
  labels: ReadonlyArray<string>,
  city: string,
  preferredCountry?: string,
): CityOptionMatch {
  const target = String(city || "").trim();
  if (!target) {
    return { kind: "missing", seen: labels.map((value) => value.trim()).filter(Boolean), reason: "notFound" };
  }
  const seen = labels.map((value) => value.trim()).filter(Boolean);
  const splitLabel = (label: string) => {
    const text = label.trim();
    const dash = text.indexOf("-");
    if (dash > 0 && dash < text.length - 1) {
      return { country: text.slice(0, dash).trim(), city: text.slice(dash + 1).trim() };
    }
    return { country: "", city: text };
  };
  const matches = seen
    .map((label, index) => ({ label, index, ...splitLabel(label) }))
    .filter((entry) => entry.city === target);

  if (preferredCountry) {
    const wantedCountry = preferredCountry.trim();
    const inCountry = matches.filter((entry) => entry.country === wantedCountry);
    if (inCountry.length === 1) {
      return { kind: "matched", index: inCountry[0].index, label: inCountry[0].label };
    }
    if (inCountry.length > 1) {
      return { kind: "ambiguous", labels: inCountry.map((entry) => entry.label) };
    }
    return { kind: "missing", seen, reason: "wrongCountry" };
  }

  // 未指定国家：精确到「城市」本身即可。裸城市名（无国家前缀）属于 VBK 历史
  // 旧数据，作为唯一候选时仍允许；多于 1 个候选视为歧义，绝不默认第一项。
  const exactCity = matches.filter((entry) => entry.country === "");
  if (exactCity.length === 1) {
    return { kind: "matched", index: exactCity[0].index, label: exactCity[0].label };
  }
  if (exactCity.length > 1) {
    return { kind: "ambiguous", labels: exactCity.map((entry) => entry.label) };
  }
  if (matches.length === 1) {
    return { kind: "matched", index: matches[0].index, label: matches[0].label };
  }
  if (matches.length > 1) {
    return { kind: "ambiguous", labels: matches.map((entry) => entry.label) };
  }
  return { kind: "missing", seen, reason: "notFound" };
}

async function fillCitySelect(page, id, city, preferredCountry, extra = {}) {
  const disambiguator = extra?.disambiguator;
  const product = extra?.product ?? {};
  // Ant Design renders the select container and its searchable input with the
  // same id. Scope to the select container first so duplicate ids do not make
  // the locator ambiguous.
  const select = page.locator(`div[id="${id}"]`);
  await assertCount(select, 1, `${city}城市选择器`);

  // 阶段重试会重新执行基本信息；此时城市通常已经选中。旧版 Ant Select
  // 的搜索 input 在收起状态仍留在 DOM，但不可见，继续 fill 会一直等到
  // Playwright 超时。先读取当前选中值，精确命中目标城市就幂等跳过。
  // 必须把国家前缀也一起校验：朝鲜-大同既不是中国-大同，也不允许在指定
  // preferredCountry="中国" 时被当作命中目标静默跳过。
  const selectedValue = select.locator(".ant-select-selection-selected-value");
  if (await selectedValue.count()) {
    const selectedText = (
      (await selectedValue.getAttribute("title")) ||
      (await selectedValue.innerText().catch(() => ""))
    ).trim();
    const verdict = pickCityOption([selectedText], city, preferredCountry);
    if (verdict.kind === "matched") return;

    if (selectedText) {
      // Ant v3 单选清除按钮：scoped 到本 select 容器内，hover 才渲染；
      // 顺序：hover → assertCount → click → waitFor hidden，任一步失败
      // 抛中文错误，绝不 force、绝不 fill 隐藏 input。
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

  // 必须点可见的 selection 外壳打开下拉，不能点收起时隐藏的 combobox
  // input。打开后再等待搜索框可见；若旧版 Ant Select 第一次点击未展开，
  // 只允许重试点击当前 selection，绝不操作隐藏 input。
  const selection = select.locator(".ant-select-selection");
  await assertCount(selection, 1, `${city}城市可见选择框`);
  await selection.click();

  const input = select.locator("input.ant-select-search__field");
  await assertCount(input, 1, `${city}城市输入框`);
  try {
    await input.waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    // 第一次点击未展开：只重试一次 scoped click 到 selection，绝不
    // 操作隐藏 input，绝不 force。
    await selection.click();
    await input.waitFor({ state: "visible", timeout: 5_000 });
  }
  await input.fill("");
  // Ant Select only starts its remote search after real keyboard input. fill()
  // alone updates the DOM value but does not trigger the debounce request.
  await input.type(city, { delay: 80 });

  // 远程搜索会先返回首字「太」的旧结果，再异步刷新为完整「太原」结果。
  // 不能对 hasText(city) 单次 wait，也不能退回第一项；持续读取当前可见弹层，
  // 用 pickCityOption 按「国家-城市」精确匹配后再点击；指定 preferredCountry
  // 时不允许回退到其它国家同名城市。
  const options = page.locator(
    ".ant-select-dropdown:not(.ant-select-dropdown-hidden) li[role=option]",
  );
  const deadline = Date.now() + 8_000;
  let lastSeen: string[] = [];
  let lastDecision: CityOptionMatch = { kind: "missing", seen: [], reason: "notFound" };
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
    // 本地规则只决断 0/1/多个；ambiguous 与 wrongCountry 都表示“存在多个同名
    // 候选但都不是唯一精确项”，交给 AI 选一个最像的。AI 也选不出则保持原报错。
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
        candidates.map(() => false),  // 城市下拉项不设 disabled
        aliases,
        { kind: "city", desired: city, product, description: `${city}城市` },
        disambiguator,
      );
      if (ai) {
        // AI 选中的文本必然在 lastSeen 中（matchDropdownOption 已二次验证），
        // 重新按 innerText 定位到 Locator index 点击。
        const idx = lastSeen.findIndex((t) => t === ai.text);
        if (idx >= 0) {
          if (ai.source === "ai") {
            console.info("[fillCitySelect] AI 兜底选中城市", {
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
 * 产品线由目的城市/省份确定性匹配：优先“目的城市一地”，其次“省份一地”。
 * VBK 的远程选项偶尔会先显示“暂无数据”，因此允许关闭后重开轮询；一旦
 * 拿到真实选项仍未命中就直接报错，绝不默认选择第一项。
 */
async function fillProductLine(page, destinationCity, province) {
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
      await options.nth(matchIndex).click();
      await delay(300);
      return;
    }
    const realOptions = seen.filter(
      (text, index) => text && !["暂无数据", "Not Found"].includes(text) && !disableds[index],
    );
    if (realOptions.length) {
      throw new Error(`产品线未找到“${candidates.join("”或“")}”；可选：${realOptions.join("、")}`);
    }
    await page.keyboard.press("Escape").catch(() => {});
    await delay(350);
  }
  throw new Error(`产品线下拉在 10 秒内未返回可用选项；最后看到：${seen.filter(Boolean).join("、") || "无"}`);
}

export async function openProductEditor(page, productId, options = {}) {
  const { stayOnCurrentTab = false } = options;
  const targetUrl = productEditorUrl(productId);
  const current = page.url();
  const sameProduct = current.includes(encodeURIComponent(productId)) || current.includes(productId);
  const onEditorPath = /\/ivbk\/vendor\//.test(current) || /\/product\/input\//.test(current);
  // VBK 的 React Router 会拦截 page.goto（同路由上 会报 net::ERR_ABORTED）。
  // 同一产品已在任一产品页面下，直接复用，不走 goto；否则用 location.href
  // 触发完整的浏览器跳转，goto 拿到跳完之后的状态。
  if (sameProduct && onEditorPath) {
    // stayOnCurrentTab=true：中间阶段重试偏好。页面已停在某个子 tab
    // （行程描述 / 产品图文），不要强制拽回「基本信息」。各阶段 handler
    // 负责切到自己的 tab（fillItineraryDraft 会 clickSection("行程描述")
    // 如果 title input 不在 DOM）。
    if (stayOnCurrentTab) {
      return;
    }
    // 复用现有页面 — 但页面可能停在子 tab（如 行程描述），需要先点回 基本信息
    // 让后续阶段从首页开始。如果点不到，就等「基本信息」可见（通常是在
    // 基本信息 tab 被点中后出现）。
    await ensureBasicInfoTabVisible(page);
    return;
  }
  // 跳出当前跳到目标 product editor。绕过 goto，用 location.href 走浏览器原生跳转。
  await page.evaluate((url) => { window.location.href = url; }, targetUrl);
  // VBK 把行程描述拆到独立的 tourdays 页面，其它阶段还在 baseInfoMerge 页。
  // 两种 URL 都视为成功进入了产品编辑器。
  await page.waitForURL(
    (url) => typeof url === "string" && (url.includes("baseInfoMerge") || /\/ivbk\/vendor\/tourdays\?/.test(url)),
    { timeout: 30_000 },
  ).catch(() => {});
  // 等待 产品信息 tab 可见
  await page.getByText("基本信息", { exact: true }).first().waitFor({ timeout: 30_000 });
}

async function ensureBasicInfoTabVisible(page) {
  // 如果「基本信息」已经可见，直接返回
  const visible = await page.getByText("基本信息", { exact: true }).first().isVisible().catch(() => false);
  if (visible) return;
  // 点击 产品信息 / 基本信息 tab
  for (const label of ["基本信息", "产品信息"]) {
    const tab = page.getByRole("tab", { name: label, exact: true });
    if (await tab.count()) {
      await tab.first().click().catch(() => {});
      await page.getByText("基本信息", { exact: true }).first().waitFor({ timeout: 15_000 }).catch(() => {});
      return;
    }
  }
}

async function clickSection(page, labels) {
  const candidates = Array.isArray(labels) ? labels : [labels];
  let disabledLabel = "";
  for (const label of candidates) {
    // 新版 VBK 使用顶层 tab（产品信息 / 产品图文），优先按角色定位，避免
    // 同名标题或帮助文案抢占点击。旧页面再回退到精确文本。
    const tab = page.getByRole("tab", { name: label, exact: true });
    const tabCount = await tab.count();
    for (let index = 0; index < tabCount; index += 1) {
      const current = tab.nth(index);
      if (!(await current.isVisible())) continue;
      if ((await current.getAttribute("aria-disabled")) === "true") {
        disabledLabel = label;
        continue;
      }
      await current.click();
      // 点击 tab 后等 VBK 渲染完成（aria-selected=true / 对应面板出现），最多 3s。
      await pollUntil(
        current,
        (loc) => loc.getAttribute("aria-selected").then((v) => v === "true"),
        3_000,
      );
      return;
    }

    const target = page.getByText(label, { exact: true });
    const count = await target.count();
    for (let index = 0; index < count; index += 1) {
      const current = target.nth(index);
      if (!(await current.isVisible())) continue;
      const disabledAncestor = current.locator(
        'xpath=ancestor-or-self::*[@aria-disabled="true" or contains(@class,"ant-tabs-tab-disabled")][1]',
      );
      if (await disabledAncestor.count()) {
        disabledLabel = label;
        continue;
      }
      await current.click();
      await delay(500);
      return;
    }
  }
  if (disabledLabel) {
    throw new Error(`“${disabledLabel}”入口尚未解锁，请先完成产品信息录入。`);
  }
  throw new Error(`找不到“${candidates.join(" / ")}”入口`);
}

async function waitForSectionEnabled(page, labels, timeout = 15_000) {
  const candidates = Array.isArray(labels) ? labels : [labels];
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const label of candidates) {
      const tab = page.getByRole("tab", { name: label, exact: true });
      const count = await tab.count();
      for (let index = 0; index < count; index += 1) {
        const current = tab.nth(index);
        if (
          (await current.isVisible()) &&
          (await current.getAttribute("aria-disabled")) !== "true"
        ) {
          return label;
        }
      }
    }
    await delay(250);
  }
  throw new Error(`产品信息保存后仍未解锁“${candidates.join(" / ")}”，已停止后续录入。`);
}

async function clickSafeSave(page, names) {
  for (const name of names) {
    const button = page.getByRole("button", { name, exact: true });
    let target = null;
    if ((await button.count()) && (await button.first().isVisible())) {
      target = button.first();
    } else {
      // Some VBK pages render Chinese button labels with visual spacing, for
      // example "保 存". Compare normalized visible text without weakening
      // the allowed save-button name list.
      const buttons = page.getByRole("button");
      for (let index = 0; index < (await buttons.count()); index += 1) {
        const current = buttons.nth(index);
        if (!(await current.isVisible().catch(() => false))) continue;
        const text = (await current.innerText().catch(() => "")).replace(/\s+/g, "");
        if (text === name.replace(/\s+/g, "")) {
          target = current;
          break;
        }
      }
    }
    if (target) {
      await target.click();
      // VBK may show a delayed "保存成功" modal. It has to be acknowledged
      // before the next section can receive pointer events.
      await dismissKnownNoticeDialogs(page, { waitForSaveSuccess: true });
      return name;
    }
  }
  throw new Error(`找不到安全保存按钮：${names.join("、")}`);
}

async function dismissKnownNoticeDialogs(page, { waitForSaveSuccess = false } = {}) {
  const deadline = Date.now() + (waitForSaveSuccess ? 5_000 : 800);
  const knownNotice = waitForSaveSuccess
    ? /保存成功/
    : /保存成功|不能输入重复的国家或省或景区、景点、其他地区/;

  do {
    const dialogs = page.getByRole("dialog");
    const count = await dialogs.count();
    for (let index = 0; index < count; index += 1) {
      const dialog = dialogs.nth(index);
      if (!(await dialog.isVisible().catch(() => false))) continue;
      const text = (await dialog.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
      if (!knownNotice.test(text)) continue;
      const acknowledge = dialog.getByRole("button", {
        name: /^(我知道了|知道了|确 定|确定)$/,
      });
      if (await acknowledge.count()) {
        await acknowledge.first().click();
        await dialog.waitFor({ state: "hidden", timeout: 3_000 });
        await delay(300);
        return true;
      }
    }
    await delay(150);
  } while (Date.now() < deadline);

  return false;
}

/**
 * 数据风险弹窗：VBK 在「国家景区」添加景点/省份时，如果产品是境内短途旅游
 * 但下拉返回了境外同名项（典型：朝鲜-大同 / 北朝鲜-大同等），点「添加」
 * 会弹出“数据风险，原因：途径地：XXX 且 产品类型：境内短途旅游，
 * 请修改后重新操作！”的阻断弹窗。点确定/我知道了关闭，调用方应决定
 * 是跳过（景点）还是报错（省份）。
 *
 /**
 * 通用「关闭页面上能挡路的弹窗」。点 click 报错后调用。
 *
 * 默认不挑弹窗，全部都关。调用方传入 `keepOpenSelectors` 可以保留某些弹窗不被关。
 * 例如 selectStationAddress 需要保留【接送站设置】这个对话框不被关闭，
 * 只有其他意外打开的弹窗才被清除。
 *
 * @param page Playwright Page 实例。
 * @param keepOpenSelectors 可选，匹配的弹窗 / overlay 选择器会被跳过不关。
 * @returns {Promise<boolean>} 本次调用中是否成功关闭了至少一个弹窗。
 */
async function dismissDataRiskDialog(page, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  const pattern = /数据风险/;
  const buttonName = /^(我知道了|知道了|确\s*定|确定|关闭|取\s*消|取消)$/;
  do {
    const dialogs = page.getByRole("dialog");
    const count = await dialogs.count();
    for (let index = 0; index < count; index += 1) {
      const dialog = dialogs.nth(index);
      if (!(await dialog.isVisible().catch(() => false))) continue;
      const text = (await dialog.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
      if (!pattern.test(text)) continue;
      const button = dialog.getByRole("button", { name: buttonName });
      if (await button.count()) {
        await button.first().click();
        await dialog.waitFor({ state: "hidden", timeout: 3_000 }).catch(() => {});
        await delay(200);
        return text;
      }
    }
    await delay(150);
  } while (Date.now() < deadline);
  return null;
}

/**
 * 通用「关闭页面上能挡路的弹窗」：在每次 click / 重要 DOM 操作之前调一下。
 * 解决实际场景里「上次弹窗点击后没完全关闭」或「意外打开了弹窗」造成的
 * 「元素不在视口里、点不到」误报。覆盖 .ant-modal / .ant-drawer / .ant-popconfirm
 * / .ant-tooltip 等。优先点「关闭 × / 取 消 / Cancel / 关闭弹窗」关闭按钮；
 * 找不到按钮时点蒙层 / 蒙层背后点击 / 按 Escape。
 *
 * 同一调用最多会返“是否关闭了弹窗”的 boolean，调用方可以在 click 前断言：
 *   const closed = await closeBlockingDialogs(page);
 *   // closed === true 表示刚才有弹窗被关了
 *
 * @returns {Promise<boolean>} 本次调用中是否成功关闭了至少一个弹窗。
 */
async function closeBlockingDialogs(page, keepOpenSelectors = []) {
  const candidates = [
    ".ant-modal-wrap:not(.ant-modal-wrap-hidden) .ant-modal",
    ".ant-drawer-open .ant-drawer-content",
    ".ant-popconfirm:not(.ant-popconfirm-hidden)",
    ".ant-popover:not(.ant-popover-hidden) .ant-popover-inner",
    ".ant-tooltip:not(.ant-tooltip-hidden) .ant-tooltip-inner",
    '[role="dialog"]:not([aria-hidden="true"])',
    '[role="alertdialog"]:not([aria-hidden="true"])',
  ];
  const seen = new Set();
  let closedAny = false;
  for (const selector of candidates) {
    // 如果当前候选 selector 本身在 keepOpenSelectors 里，跳过。
    if (keepOpenSelectors.some((keep) => keep === selector || selector.includes(keep))) continue;
    let locators;
    try {
      locators = page.locator(selector);
    } catch {
      continue;
    }
    const count = await locators.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const dialog = locators.nth(index);
      let visible = false;
      try {
        visible = await dialog.isVisible({ timeout: 200 });
      } catch {
        continue;
      }
      if (!visible) continue;
      // 如果该 dialog 在某个 keepOpenSelector 里、并且它本身可见 — 跳过。
      if (await dialog.evaluate((el, keeps) => keeps.some((k) => el.matches(k) || el.querySelector(k)), keepOpenSelectors).catch(() => false)) continue;
      const sig = `${selector}::${index}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      const closeBtn = dialog.locator(
        ".ant-modal-close, .ant-drawer-close, [aria-label='Close'], [aria-label='关闭']",
      );
      const button = dialog.getByRole("button", { name: /^(取\s*消|取消|关\s*闭|关闭|我知道了|知道了|确\s*定|确定|Cancel|Close)$/ });
      try {
        if (await closeBtn.count()) {
          await closeBtn.first().click({ force: true, timeout: 1_500 });
        } else if (await button.count()) {
          await button.first().click({ force: true, timeout: 1_500 });
        } else {
          await page.mouse.click(8, 8);
          await page.keyboard.press("Escape");
        }
        await delay(150);
        closedAny = true;
      } catch {
        closedAny = true;
      }
    }
  }
  return closedAny;
}

export async function submitCurrentSectionAndNext(page) {
  const label = "提交审核并下一步";
  const button = page.getByRole("button", { name: label, exact: true });
  await assertCount(button, 1, `${label}按钮`);
  if (!(await button.isVisible())) throw new Error(`${label}按钮当前不可见`);
  await button.click();
  await delay(1_000);
  return { action: label };
}

/**
 * 通用 save-then-advance helper（窄修复版）：
 *
 * 状态机严格按以下顺序判定「保存后是否已真正进入目标页」：
 *   1) 先用约定的安全保存按钮保存，吃掉「保存成功」弹窗；
 *   2) URL 已落点（isTargetUrl）            → auto-navigated；
 *   3) 目标 tab 已 active（aria-selected=true 或 class 含 ant-tabs-tab-active）
 *      → auto-navigated（保存动作让页面自动切到目标 tab，也算真正进入）；
 *   4) 以上都不命中 —— 无论目标 tab 是否仅是「已解锁（aria-disabled ≠ true）
 *      但仍停在当前页」—— 都必须点唯一、可见、enabled、aria-disabled≠true
 *      的精确「下一步」按钮，绝不允许提前 clickSection 跳过这一步；
 *   5) 点击下一步后等待门禁：URL 落点 / 目标 tab active → navigated；
 *      仅目标 tab 解锁但未激活 → 安全 clickSection 落点 → tabUnlocked；
 *      都不命中 → 抛错并附带阶段/目标/观测 URL/目标 tab 上下文。
 *
 * 严格不调用 submitCurrentSectionAndNext，不做提交/发布/价格库存动作，
 * 也不接入 package / terms —— 这两个阶段的页面没有「下一步」契约，
 * 由各自 helper 自行 clickSafeSave 后返回。
 *
 * @param {object} options
 * @param {string} options.phase              阶段名（错误信息前缀）。
 * @param {string} options.targetTabLabel     目标 tab 显示文本（错误信息用）。
 * @param {string[]} options.saveButtonNames  安全保存按钮候选名。
 * @param {string[]} options.targetTabLabels  目标 tab 候选名（解锁/切换用）。
 * @param {(url: string) => boolean} options.isTargetUrl  判断 URL 是否已落点。
 * @param {string} [options.nextButtonLabel="下一步"]  下一步按钮精确文本。
 * @param {string} [options.savedWith]         上游已完成的保存名（用于返回）。
 */
async function saveThenAdvance(page, options) {
  const {
    phase,
    targetTabLabel,
    saveButtonNames,
    targetTabLabels,
    isTargetUrl,
    nextButtonLabel = "下一步",
    savedWith,
  } = options;

  // 规则 1：先点安全保存。
  const effectiveSavedWith = savedWith ?? (await clickSafeSave(page, saveButtonNames));

  // 规则 2：保存动作若让 URL 直接落点（basic 走 productImageText 段判断），
  //         视为 auto-navigated，不再点下一步。
  if (isTargetUrl(page.url())) {
    return { advanced: true, mode: "auto-navigated", savedWith: effectiveSavedWith };
  }

  // 规则 3：URL 未落点，但目标 tab 已经被保存动作切到 active（presentation
  //         / itinerary 用这个作为自动跳转证据）。注意：仅「解锁/未禁用」
  //         不算 —— 必须 aria-selected=true 或 class 含 ant-tabs-tab-active
  //         才是真正激活。仅解锁而仍停在当前页 → 必须点下一步。
  // VBK 保存动作切 tab 是异步的，跨子帧都需要至少 3s 才到位。
  const activeBeforeClick = await findActiveTabLabel(page, targetTabLabels, 3_000);
  if (activeBeforeClick) {
    return { advanced: true, mode: "auto-navigated", savedWith: effectiveSavedWith };
  }

  // 规则 4：URL 没落点、目标 tab 也未激活 → 无论 tab 是否仅「解锁」都必须
  //         点唯一、可见、enabled、aria-disabled≠true 的精确「下一步」。
  const buttons = page.getByRole("button", { name: nextButtonLabel, exact: true });
  const count = await buttons.count();
  if (count !== 1) {
    throw new Error(
      `${phase}的「${nextButtonLabel}」按钮数量异常：期望 1，实际 ${count}；观测 URL=${page.url()}；目标 tab=${targetTabLabel}。`,
    );
  }
  const button = buttons.first();
  if (!(await button.isVisible())) {
    throw new Error(
      `${phase}的「${nextButtonLabel}」按钮当前不可见，无法提交；观测 URL=${page.url()}；目标 tab=${targetTabLabel}。`,
    );
  }
  if (!((await button.isEnabled()) ?? true)) {
    throw new Error(
      `${phase}的「${nextButtonLabel}」按钮处于 disabled 状态，无法提交；观测 URL=${page.url()}；目标 tab=${targetTabLabel}。`,
    );
  }
  if ((await button.getAttribute("aria-disabled")) === "true") {
    throw new Error(
      `${phase}的「${nextButtonLabel}」按钮 aria-disabled=true，无法提交；观测 URL=${page.url()}；目标 tab=${targetTabLabel}。`,
    );
  }
  await button.click();

  // 清理「保存成功」弹窗。
  await dismissKnownNoticeDialogs(page, { waitForSaveSuccess: true });

  // 规则 5：点完下一步后等待真正门禁，先到者胜出。
  //   - URL 落点或目标 tab active → 真正进入目标页，navigated；
  //   - 仅目标 tab 解锁（aria-disabled ≠ true）但未 active → 安全
  //     clickSection 切到目标 tab 完成落点，tabUnlocked；
  //   - 都不命中 → 抛错并附阶段 / 目标 / 观测 URL / 目标 tab 上下文。
  const deadline = Date.now() + 15_000;
  let navigated = false;
  let activeLabel: string | null = null;
  let unlockedLabel: string | null = null;
  let observedUrl = page.url();
  while (Date.now() < deadline) {
    const url = page.url();
    observedUrl = url;
    if (isTargetUrl(url)) {
      navigated = true;
      break;
    }
    activeLabel = await findActiveTabLabel(page, targetTabLabels);
    if (activeLabel) {
      navigated = true;
      break;
    }
    unlockedLabel = await findUnlockedSectionLabel(page, targetTabLabels);
    if (unlockedLabel) break;
    await delay(250);
  }

  if (navigated) return { advanced: true, mode: "navigated", savedWith: effectiveSavedWith };

  if (unlockedLabel) {
    // 仅解锁未激活：安全切到该 tab 完成落点，绝不再点一次「下一步」。
    await clickSection(page, unlockedLabel);
    return { advanced: true, mode: "tabUnlocked", savedWith: effectiveSavedWith };
  }

  throw new Error(
    `${phase}点击「${nextButtonLabel}」后未到达目标「${targetTabLabel}」：URL=${observedUrl}，目标 tab 仍未解锁。`,
  );
}

/**
 * 目标 tab 是否已激活：aria-selected=true（Ant Design 的标准 ARIA），
 * 或 class 含 ant-tabs-tab-active（旧版 Ant / 自定义 Tab 仍用 className 标记）。
 * 命中即视为真正切到目标 tab。
 */
async function findActiveTabLabel(page, labels, timeoutMs = 0) {
  const candidates = Array.isArray(labels) ? labels : [labels];
  const probe = async () => {
    for (const label of candidates) {
      const tab = page.getByRole("tab", { name: label, exact: true });
      const tabCount = await tab.count();
      for (let index = 0; index < tabCount; index += 1) {
        const current = tab.nth(index);
        if (!(await current.isVisible())) continue;
        if ((await current.getAttribute("aria-selected")) === "true") return label;
        const cls = (await current.getAttribute("class")) || "";
        if (/\bant-tabs-tab-active\b/.test(cls)) return label;
      }
    }
    return null;
  };
  if (timeoutMs <= 0) return probe();
  // VBK 保存动作切 tab 是异步的，跨子帧都需要至少 3s 才到位。
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await delay(150);
  }
  return last;
}

async function findUnlockedSectionLabel(page, labels) {
  const candidates = Array.isArray(labels) ? labels : [labels];
  for (const label of candidates) {
    const tab = page.getByRole("tab", { name: label, exact: true });
    const tabCount = await tab.count();
    for (let index = 0; index < tabCount; index += 1) {
      const current = tab.nth(index);
      if (!(await current.isVisible())) continue;
      if ((await current.getAttribute("aria-disabled")) === "true") continue;
      return label;
    }
  }
  return null;
}

// 真实 VBK 跳转目标 URL 形如：
//   https://vbooking.ctrip.com/ivbk/vendor/productImageText?productId=...
// 即路径段是 productImageText（不一定带尾斜杠），因此用「前后为 /、?、&
// 之一」做片段级判断，避免误命中 `vendor/productImageTextList` 这类无关
// 子路径，也避免误命中查询串里的 productImageText 关键字。
const PRODUCT_IMAGE_TEXT_REGEX = /(^|[/?&])productImageText([/?&]|$)/;

// 暴露路径段名称供消费方（其它 helper、日志、测试）使用；判断逻辑交给
// isProductImageTextUrl，避免有人用裸 includes 写出脆弱的子串匹配。
export const PRODUCT_IMAGE_TEXT_PATH = "productImageText";

export function isProductImageTextUrl(url) {
  if (typeof url !== "string" || !url) return false;
  return PRODUCT_IMAGE_TEXT_REGEX.test(url);
}

export async function fillAndSaveBasicInfo(page, product, butlerSelection, extra = {}) {
  // 失败阶段重试可能继承上一次保存/校验弹窗；先关闭已知的纯提示弹窗，
  // 否则它会遮挡下拉框并让 Playwright 点击超时。
  await dismissKnownNoticeDialogs(page);
  await clickSection(page, ["产品信息", "基本信息"]).catch(() => {});
  await fillBasicInfo(page, product, butlerSelection, extra);

  // 先扫一次红错：保存之前的 VBK 残留校验必须在此抛出，绝不向下传。
  await assertBasicInfoNoRedErrors(page);

  // 调用通用 save-then-advance：目标 URL 是 productImageText，
  // 目标 tab 是「产品图文 / 图文信息」之一。
  const advanced = await saveThenAdvance(page, {
    phase: "基本信息",
    targetTabLabel: "产品图文/图文信息",
    saveButtonNames: ["保存", "保存并下一步"],
    targetTabLabels: ["产品图文", "图文信息"],
    isTargetUrl: isProductImageTextUrl,
  });

  // 走到这里说明下一步门禁已通过——再扫一次红错，避免 tabUnlocked 分支下
  // 红错被吞掉。
  await assertBasicInfoNoRedErrors(page);
  return advanced;
}

// VBK #pm_recommend 默认只渲染 1 行；plan 永远 3 项，所以开始填写前必须
// 把行数补足。真实 VBK 在每行末尾放一个蓝图标 +（背景 color 由源码的
// #1658DC 被浏览器序列化为 rgb(22, 88, 220)）；行 ≥2 时 + 前还有一个
// − 删行按钮。两个按钮共享相同的 span.anticon + 内联 color rgb(22,88,220)，
// 顺序固定为「− 在前、+ 在后」。直接 page.locator(...).click() 会被
// span[title=空] 拦截，必须在 evaluate 里调 .click() 事件触发。测试 fixture
// 使用 #1658DC 原始字串，所以这里同时匹配 rgb 序列化与 #hex 两种写法。
const RECOMMEND_APPEND_BUTTON_SELECTOR =
  'span.anticon[style*="rgb(22, 88, 220)"], span.anticon[style*="#1658DC"], span.anticon[style*="#1658dc"]';

async function appendRecommendationRow(page: Page, currentCount: number) {
  // 每次只负责点 + 一次并等「多 1 行」出现；多轮调用在 fillRecommendationReasons
  // 的 while 循环里驱动。一次性等 targetCount 会让首轮点击后永远等不到
  // （剩余行还没追加），触发误报。
  const clicked = await page.evaluate((selector) => {
    const all = document.querySelectorAll("#pm_recommend .ant-form-item");
    if (all.length === 0) return { ok: false, reason: "empty" };
    const last = all[all.length - 1];
    const blues = last.querySelectorAll(selector);
    if (blues.length === 0) {
      return { ok: false, reason: "no-plus", rowCount: all.length };
    }
    // 同一个最后一行内可能同时有 − 和 +；点 + 即最后一个蓝图标。
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
      (target) =>
        document.querySelectorAll("#pm_recommend .ant-form-item").length >= target,
      expectedCount,
      { timeout: 10_000 },
    );
  } catch {
    // 真实 VBK 偶尔在新行 DOM 上慢一拍；再轮询一次兜底，避免误抛
    // 「未生成第 N+1 组」。
    await page.waitForFunction(
      (target) =>
        document.querySelectorAll("#pm_recommend .ant-form-item").length >= target,
      expectedCount,
      { timeout: 5_000 },
    );
  }
}

export async function fillRecommendationReasons(page: Page, recommendations: Array<{ category: string; text: string }>) {
  const plan = buildRecommendationReasonsPlan(recommendations);
  const section = page.locator("#pm_recommend");
  await assertCount(section, 1, "推荐理由区域");
  const rows = section.locator(".ant-form-item");

  // VBK 默认渲染 1 行；plan 长度固定 3。开始填写前先把行数扩到 plan.length，
  // 否则断言会先在 row count 上抛错。每一次扩行都点最后一行末尾的 + 按钮。
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
      // 真实 VBK DOM：input[role=combobox] 与 span.ant-select-selection-item 是
      // 同一 div.ant-select-selector 下的兄弟节点；selection item 才是已选文本。
      // 点击 selector 外壳打开下拉，避开点击收起时不可见的 input。
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
        // 忽略：下拉层可能被下一个动作关闭；后面用 selection item innerText
        // 做最终校验。
      }
      // 等待 selection item 可见且 innerText 精确等于目标；用 Playwright 端
      // locator 直接等待，不在 evaluate 内自建长异步轮询。
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
      } catch (error) {
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

async function hasCoverImage(page) {
  const cover = page.locator(".image-category-container").filter({ hasText: /^\*?封面/ }).first();
  if (!(await cover.count())) return false;
  return (await cover.locator(".drag-nav-container img").count()) > 0;
}

async function selectSearchOption(page, dialog, id, value, description) {
  const input = dialog.locator(`#${id}`);
  await assertCount(input, 1, `${description}搜索框`);
  await input.click();
  await input.fill("");
  await input.pressSequentially(value, { delay: 80 });
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
  throw new Error(`${description}未找到“${value}”；可选：${seen.join("、") || "无"}`);
}

export type { CtripLibraryImageAspect };

export type LibraryImageParams = {
  trigger: any;
  poi: string;
  description?: string;
  minQuality?: number;
  aspect?: CtripLibraryImageAspect;
  label: string;
};

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

  const descInput = dialog.locator("#description");
  if (description && (await descInput.count())) await descInput.fill(description);

  const queryBtn = dialog.getByRole("button", { name: /查\s*询/ });
  await queryBtn.waitFor({ state: "visible" });
  await queryBtn.click();

  const cards = dialog.locator(".importpic-modal-picitem");
  const deadline = Date.now() + 8_000;
  let count = 0;
  while (Date.now() < deadline) {
    count = await cards.count();
    if (count > 0) break;
    await delay(250);
  }
  if (count === 0) {
    throw new Error(
      `${label}: '${poi}' 在携程图库未找到符合质量要求的图片(质量分 ≥ ${minQuality},${aspect === "landscape" ? "最小 1280×800 横版" : "宽高不限但 ≥1280×800"})`,
    );
  }

  const candidates: Array<{ quality: string; resolution: string }> = [];
  for (let index = 0; index < count; index += 1) {
    const text = (await cards.nth(index).innerText()).replace(/\s+/g, " ");
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
  await cards.nth(selectedIndex).click();

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

async function selectCtripLibraryCover(page, cover) {
  if (await hasCoverImage(page)) return { reused: true };

  const section = page.locator(".image-category-container").filter({ hasText: /^\*?封面/ }).first();
  await assertCount(section, 1, "封面图片区块");
  const addCard = section.locator(".add-image-card");
  await assertCount(addCard, 1, "封面添加图片入口");
  await addCard.hover();
  const libraryImport = addCard.getByText("图库导入", { exact: true });
  await libraryImport.waitFor({ state: "visible", timeout: 3_000 });
  await libraryImport.click();

  const dialog = page.getByRole("dialog").filter({ hasText: "从图库资源导入" });
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  await selectSearchOption(page, dialog, "PoiId", cover.poi, "携程图库景点");
  const description = dialog.locator("#description");
  if (cover.description && (await description.count())) await description.fill(cover.description);
  await dialog.getByRole("button", { name: /查\s*询/ }).click();

  const cards = dialog.locator(".importpic-modal-picitem");
  await cards.first().waitFor({ state: "visible", timeout: 10_000 });
  const candidates = [];
  for (let index = 0; index < (await cards.count()); index += 1) {
    const text = (await cards.nth(index).innerText()).replace(/\s+/g, " ");
    candidates.push({
      quality: text.match(/质量分：\s*([\d.]+(?:\s*-\s*[\d.]+)?)/)?.[1] || "",
      resolution: text.match(/分辨率：\s*(\d+\s*\*\s*\d+)/)?.[1] || "",
    });
  }
  const selectedIndex = findBestCtripLibraryImage(candidates, cover.minQuality ?? 3);
  if (selectedIndex < 0) {
    throw new Error(
      `携程图库未找到符合封面标准的“${cover.poi}”图片：最低质量分 ${cover.minQuality ?? 3}，横版分辨率至少 1280×800。`,
    );
  }
  await cards.nth(selectedIndex).click();

  const agreement = dialog.getByText(/我已仔细阅读并同意/).locator("xpath=ancestor::label[1]");
  if (await agreement.count()) {
    const checkbox = agreement.locator('input[type="checkbox"]');
    if ((await checkbox.count()) && !(await checkbox.isChecked())) await agreement.click();
  }
  const confirm = dialog.getByRole("button", { name: /同意并导入/ });
  await confirm.click();
  await dialog.waitFor({ state: "hidden", timeout: 15_000 });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await hasCoverImage(page)) return { reused: false };
    await delay(250);
  }
  throw new Error(`已从携程图库导入“${cover.poi}”，但封面未显示在产品图文页。`);
}

export async function fillAndSavePresentation(page, product) {
  const presentation = product.presentation;
  if (!presentation?.cover) {
    throw new Error("产品图文缺少携程图库封面配置，已停止后续录入。");
  }
  await clickSection(page, ["产品图文", "图文信息"]);
  if (presentation.recommendations?.length === 3) {
    await fillRecommendationReasons(page, presentation.recommendations);
  }
  await selectCtripLibraryCover(page, presentation.cover);
  await fillFirstVisible(
    page.locator('textarea[placeholder*="推荐"], textarea'),
    presentation.recommendation,
    "推荐语输入框",
  );
  const editor = page.locator('[contenteditable="true"]');
  for (let index = 0; index < (await editor.count()); index += 1) {
    if (await editor.nth(index).isVisible()) {
      await editor.nth(index).fill(presentation.features);
      break;
    }
  }
  // 推进到「行程描述」tab。VBK 行程描述页没有公开的稳定 URL 路径段，
  // 中文 tab 名不可能匹配英文 URL，伪判断已被禁止；自动跳转证据
  // 改由通用 helper 内部的「目标 tab active」门禁（aria-selected=true
  // 或 ant-tabs-tab-active）承担。isTargetUrl 改为「URL 段已离开当前
  // 阶段（productImageText）」作为兜底，离开即视为跳页。
  return saveThenAdvance(page, {
    phase: "产品图文",
    targetTabLabel: "行程描述",
    saveButtonNames: ["保存", "保存并下一步"],
    targetTabLabels: ["行程描述"],
    isTargetUrl: (url) =>
      typeof url === "string" && !/(^|[/?&])productImageText([/?&]|$)/.test(url),
  });
}

function dayScopeFor(titleInput) {
  return titleInput.locator(
    'xpath=ancestor::*[contains(@class,"td-day-item--")][1]',
  );
}

async function ensureOtherCard(page, dayScope, { afterFirstCard = false } = {}) {
  const otherCards = dayScope
    .locator('[class*="td-day-card--"]')
    .filter({ hasText: "其他" });
  while ((await otherCards.count()) > 1) {
    const before = await otherCards.count();
    await otherCards.last().getByText("删除", { exact: true }).click({ force: true });
    await delay(300);
    const confirm = page.getByText("确定", { exact: true });
    for (let index = (await confirm.count()) - 1; index >= 0; index -= 1) {
      if (await confirm.nth(index).isVisible()) {
        await confirm.nth(index).click({ force: true });
        break;
      }
    }
    for (let attempt = 0; attempt < 20 && (await otherCards.count()) >= before; attempt += 1) {
      await delay(100);
    }
  }
  if (await otherCards.count()) return otherCards.first();

  const addBoxes = dayScope.locator('[class*="td-add-box"]');
  const addBox = addBoxes.nth(afterFirstCard ? 1 : 0);
  await addBox.locator('[class*="td-add-plus-btn"]').click();
  await delay(500);
  const menuItem = addBox
    .locator('[class*="td-add-item-btn-new"]')
    .filter({ hasText: "其他" });
  let clicked = false;
  for (let index = 0; index < (await menuItem.count()); index += 1) {
    if (await menuItem.nth(index).isVisible()) {
      await menuItem.nth(index).click();
      clicked = true;
      break;
    }
  }
  if (!clicked) throw new Error("新增菜单已打开，但找不到可点击的“其他”节点");
  await otherCards.first().waitFor({ state: "visible", timeout: 8_000 });
  return otherCards.first();
}

async function clickExact(scope, label, description = label) {
  const matches = scope.getByText(label, { exact: true });
  const count = await matches.count();
  for (let index = 0; index < count; index += 1) {
    if (await matches.nth(index).isVisible()) {
      await matches.nth(index).click({ force: true });
      return;
    }
  }
  throw new Error(`找不到可点击的${description}`);
}

async function cardsByPrefix(dayScope, prefix) {
  const cards = dayScope.locator('[class*="td-day-card--"]');
  const texts = await cards.allTextContents();
  return texts.flatMap((text, index) =>
    text.trim().startsWith(prefix) ? [cards.nth(index)] : [],
  );
}

async function clickLabelExact(scope, label, description = label) {
  const labels = scope.locator("label").filter({ hasText: label });
  for (let index = 0; index < (await labels.count()); index += 1) {
    const text = (await labels.nth(index).allTextContents()).join("").trim();
    if (text === label && (await labels.nth(index).isVisible())) {
      await labels.nth(index).click({ force: true });
      return;
    }
  }
  throw new Error(`找不到${description}标签`);
}

async function ensureCheckboxChecked(checkbox) {
  const parentClass = (await checkbox.locator("xpath=..").getAttribute("class")) ?? "";
  if (!parentClass.includes("ant-checkbox-checked")) {
    await checkbox.click({ force: true });
  }
}

async function fillMealCards(dayScope, day, mealsIncluded = false) {
  const mealCards = await cardsByPrefix(dayScope, "餐饮");
  if (mealCards.length !== 3) {
    throw new Error(`第 ${day.day} 天餐饮节点数量异常：期望 3，实际 ${mealCards.length}`);
  }
  const types = ["早餐", "午餐", "晚餐"];
  const descriptions = day.mealDescriptions ?? [day.meals, day.meals, day.meals];

  for (let index = 0; index < 3; index += 1) {
    const card = mealCards[index];
    await clickExact(card, "不限", `第 ${day.day} 天${types[index]}时间`);
    await clickExact(card, types[index], `第 ${day.day} 天餐饮类型`);
    // 含餐产品不能勾「费用自理」，否则录入结果与产品数据相反。
    if (!mealsIncluded) {
      const selfPay = card.getByText("费用自理", { exact: true });
      await assertCount(selfPay, 2, `第 ${day.day} 天${types[index]}费用自理选项`);
      await selfPay.nth(0).click({ force: true });
      await selfPay.nth(1).click({ force: true });
    }
    const supplement = card.locator('textarea[placeholder="请输入补充说明"]');
    if (await supplement.count()) await supplement.first().fill(descriptions[index]);
  }
}

async function fillHotelCard(page, dayScope, day, operations) {
  // 酒店节点：两天行程的第二天通常没有酒店节点，应跳过不报错。
  const hotelCards = await cardsByPrefix(dayScope, "酒店");
  if (hotelCards.length === 0) return;
  if (hotelCards.length !== 1) {
    throw new Error(`第 ${day.day} 天酒店节点数量异常：期望 1，实际 ${hotelCards.length}`);
  }
  const hotelCard = hotelCards[0];
  await clickExact(hotelCard, "不限", `第 ${day.day} 天酒店时间`);
  await clickExact(hotelCard, "不使用携程平台酒店", "非平台酒店来源");
  await delay(300);
  // 默认按 hotelTier（“当地4钻酒店/-4” / “当地3钻酒店/-3”）选酒店名称。
  // 即使 day.hotel 为空也应当选一个默认酒店，不然 VBK 会判酒店名未填。
  const combos = hotelCard.getByRole("combobox");
  if (!(await combos.count())) throw new Error(`第 ${day.day} 天酒店名称选择器缺失`);
  await combos.last().click();
  await delay(300);
  // 默认选“当地4钻酒店/-4”，未提供则 fallback 到“当地3钻酒店/-3”。
  const tierKeyword = operations.hotelTier && /4钻/.test(operations.hotelTier)
    ? "当地4钻酒店/-4"
    : "当地3钻酒店/-3";
  await selectVisibleOption(page, tierKeyword);
  const supplement = hotelCard.locator('textarea[placeholder="请输入补充说明"]');
  if (await supplement.count()) {
    await supplement.first().fill(day.hotelDescription || day.hotel || `依据产品配置：${operations.hotelTier}`);
  }
}

// 暴露给 debug：直接调这个函数能复现「接送站」单步场景。
export async function selectStationAddress(page, card, city, extra = {}) {
  const disambiguator = extra?.disambiguator;
  const product = extra?.product ?? {};
  await breakpoint("selectStationAddress:enter", { city });
  const addressInput = card.locator('input.ant-input[placeholder="请选择"]');
  if (!(await addressInput.count())) throw new Error("接送站地址输入框缺失");
  await safeClick(page, addressInput.first());
  await delay(300);
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ state: "visible", timeout: 5_000 });
  const inputs = dialog.locator("input");
  if ((await inputs.count()) < 2) throw new Error("接送站弹窗结构异常");
  // 弹窗里第 1 个可写输入是机场，第 2 个是火车站。两者都逐个填，
  // 任意一个 dropdown 返回空则跳过不报错。所有搜索都以 city 为查询，
  // dropdown 内逐候选项比对：唯一可用项 → 直选；与 city 完全一致 → 直选；
  // 否则调 disambiguator（AI 兜底）。AI 网络错误不接外。
  async function fillStationField(fieldIndex, kind) {
    const input = inputs.nth(fieldIndex);
    await safeClick(page, input);
    await input.fill("").catch(() => {});
    await input.type(city, { delay: 80 });
    // VBK 接送站搜索接口反应慢，3s 才出 dropdown。
    await delay(3_000);
    const dropdown = page.locator(
      '.ant-select-dropdown--multiple:not(.ant-select-dropdown-hidden)',
    ).last();
    // 【重要】本函数运行在接送站弹窗内部，不能调 closeBlockingDialogs
    // 去收其它遮罩弹窗——closeBlockingDialogs 判定是按 role="dialog" / 「确定」
    // 按钮文本枚举的，它会把接送站弹窗自己一起关掉，让后续 click 超时。
    // 原代码在多处调 closeBlockingDialogs 是错的：弹窗里不会有别的遮罩，
    // 跳出后所有的 dropdown 都会被弹窗一起藏起来。
    // 退路：只按 Esc 收一下可能残留的 tooltip/popover，不动 role=dialog。
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
    if (!total) {
      return { matched: false, reason: "empty-list" };
    }
    const texts = (await options.allInnerTexts().catch(() => [])).map((text) => text.trim());
    const disableds = await Promise.all(
      Array.from({ length: total }, async (_, i) => {
        const cls = (await options.nth(i).getAttribute("class").catch(() => "")) || "";
        return /ant-select-item-disabled|ant-select-dropdown-menu-item-disabled/.test(cls);
      }),
    );
    const usable = texts.filter((_, i) => !disableds[i]);
    // 1) 唯一可用项 → 直选。
    if (usable.length === 1) {
      const idx = texts.findIndex(t => t === usable[0]);
      await delay(150);
      await options.nth(idx).click({ force: true });
      await delay(200);
      // 选项被 force-click 之后 dropdown 不会自动关闭，会拦截下一次
      // 输入框 click。按 Esc 收掉 dropdown，但不要触碰接送站 dialog 本体。
      await page.keyboard.press("Escape").catch(() => false);
      await delay(150);
      return { matched: true, source: "single", text: usable[0] };
    }
    // 2) 与 city 完全一致 → 直选。
    const exactIdx = usable.findIndex(t => t.trim() === city);
    if (exactIdx >= 0) {
      const idx = texts.findIndex(t => t === usable[exactIdx]);
      await delay(150);
      await options.nth(idx).click({ force: true });
      await delay(200);
      // 同样的 force-click 问题：手动 Esc 关闭 dropdown。
      await page.keyboard.press("Escape").catch(() => false);
      await delay(150);
      return { matched: true, source: "exact", text: usable[exactIdx] };
    }
    // 3) AI 兑底。disambiguator 返回的 aiMatch 有两种契约：
    //   a) { index, text, reasoning? }   — 直接给出索引（老调用方）
    //   b) { pickedText, reasoning? }    — 返文本，由本函数定位索引（新调用方）
    // 两种都允许。定位后还要二次校验「该索引未被 disabled、文本不空」才点。
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
          return { matched: true, source: "ai", text: candidates[chosenIndex].text, reasoning: aiMatch.reasoning };
        }
      } catch (err) {
        console.warn("[selectStationAddress] AI 兑底失败，跳过本字段", { kind, err: String(err.message || err) });
      }
    }
    // 4) 列表不为空但无法选 → 只收 Esc，不动弹窗本身，保留机会重试。
    await collapseOverlayTooltips();
    return { matched: false, reason: "no-match", candidates: usable };
  }
  // dialog 实际只有 2 个 input（皆为 .ant-select-search__field 搜索框）：
  //   - 索引 0 → 机场搜索框
  //   - 索引 1 → 火车站搜索框
  // 旧版曾认为「有隐藏 input，从下标 1 起」——在当前 VBK DOM 里已不成立，
  // 旧索引导致机场被填到火车字段、火车取越界索引 30s 超时。
  const airportResult = await fillStationField(0, "airport");
  console.info("[selectStationAddress] airport", JSON.stringify(airportResult));
  await delay(300);
  const trainResult = await fillStationField(1, "train");
  console.info("[selectStationAddress] train", JSON.stringify(trainResult));
  // 关闭弹窗。
  const confirm = dialog.getByRole("button", { name: "确定", exact: true });
  if (await confirm.count()) {
    await safeClick(page, confirm, { force: true }).catch(() => false);
    await delay(300);
    if (await dialog.isVisible().catch(() => false)) {
      await safeClick(page, confirm, { force: true }).catch(() => false);
      await delay(300);
    }
  }
  // 接送站弹窗已点「确定」，到这一步应已闭合；但如果某些状态下
  // 弹窗仍残留（edge case），点 Esc 收一下 tooltip/popover 即可，
  // 不要再走 closeBlockingDialogs——它会把刚提交、还没保存的
  // 弹窗一起关掉，导致「确定」动作被吞。
  await page.keyboard.press("Escape").catch(() => false);
  await breakpoint("selectStationAddress:done");
}

async function fillPickupAndDropoff(page, dayScope, index, totalDays, operations, extra = {}) {
  const disambiguator = extra?.disambiguator;
  const product = extra?.product;
  // 集合 / 解散 card 里的“接机/站地址”可能有几个空““请选择”输入。这些
  // 是 station 地址下拉，不是 city 下拉。原来的逻辑只填第一个 .first()，
  // 如果第一个已经被填了（实际是集合点 city），后面的 station 地址会被漏下。
  // 这里改成：过滤掉已有 value 的，请空值的“接机/站地址”才能进 selectStationAddress。
  // 同时跳过在“全天具体时间”里的那个（时间控件不是 station 下拉）。
  async function fillEmptyStationAddresses(card) {
    const stationInputs = card.locator('input.ant-input[placeholder="请选择"]');
    const total = await stationInputs.count();
    for (let i = 0; i < total; i += 1) {
      const input = stationInputs.nth(i);
      const value = await input.getAttribute("value").catch(() => "");
      if (value && value.trim()) continue;
      const isTimeSlot = await input.evaluate((el) => {
        let parent = el.parentElement;
        while (parent && parent !== document.body) {
          const txt = parent.textContent || "";
          if (txt.includes("全天具体时间")) return true;
          parent = parent.parentElement;
        }
        return false;
      }).catch(() => false);
      if (isTimeSlot) continue;
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
    let reused = false;
    if (operations.reusePickupForDropoff) {
      if ((await modes.count()) >= 3) {
        await ensureCheckboxChecked(modes.nth(2));
        reused = true;
      }
    }
    await fillEmptyStationAddresses(cards[0]);
  }
}

export async function fillItineraryDraft(page, product, options = {}) {
  // options.disambiguator — 接送站「精确→AI」兜底，由 automation.ts 注入
  // product 总是从调用方传入；这里只是把它的句柄存下来往下传。
  const disambiguator = options?.disambiguator;
  let titleInputs = page.locator('textarea[placeholder^="请输入标题"]');
  if ((await titleInputs.count()) !== product.itinerary.length) {
    await clickSection(page, "行程描述");
    titleInputs = page.locator('textarea[placeholder^="请输入标题"]');
  }
  // 点击行程描述 tab 后页面异步渲染最多需 3s，轮询 titleInputs 到位才对。
  // count 没到期望值的话报“期望 X，实际 0”与预期不一致。
  const titleReady = await pollUntil(
    titleInputs,
    (loc) => loc.count().then((n) => n === product.itinerary.length),
    3_000,
  );
  if (!titleReady) {
    await assertCount(titleInputs, product.itinerary.length, "每日标题输入框");
  }

  for (let index = 0; index < product.itinerary.length; index += 1) {
    const day = product.itinerary[index];
    const titleInput = titleInputs.nth(index);
    await titleInput.fill(day.title);
    const scope = dayScopeFor(titleInput);
    await assertCount(scope, 1, `第 ${day.day} 天行程区域`);
    if (product.operations?.transport === "charter") {
      await clickExact(scope, "包车", `第 ${day.day} 天包车选项`);
    }
    await fillPickupAndDropoff(
      page,
      scope,
      index,
      product.itinerary.length,
      product.operations ?? {
        reusePickupForDropoff: true,
      },
      { disambiguator, product },
    );
    await fillMealCards(scope, day, product.operations?.mealsIncluded === true);
    if (product.operations) {
      await fillHotelCard(page, scope, day, product.operations);
    }
    const otherCard = await ensureOtherCard(page, scope, {
      afterFirstCard: index === 0,
    });
    const unlimited = otherCard.getByText("不限", { exact: true });
    if (await unlimited.count()) await unlimited.first().click();
    const description = otherCard.locator('textarea[placeholder="请输入补充说明"]');
    if (!(await description.count())) {
      throw new Error(`第 ${day.day} 天“其他”节点缺少补充说明`);
    }
    await description.first().fill(day.description);
  }

  const savedWith = await clickSafeSave(page, ["存为草稿"]);
  // 推进到「套餐管理」tab。行程描述 / 套餐管理在真实 VBK 站里是同一
  // baseInfoMerge 页内的两个 tab，URL 在它们之间切换时不会变化；而某些
  // 进入路径下 URL 干脆不带 baseInfoMerge 段（例如直接跳到 itinerary 独
  // 立页）。任何「URL 含 / 不含某路径段」的反向判断都会在每次保存后立刻
  // 误判 auto-navigated 并跳过点下一步。Codex 已通过真实 DOM 验证：顶
  // 层 role=tab 用 aria-selected=true 才是稳定可靠的自动跳转证据。本阶
  // 段 isTargetUrl 永不自行判定 URL 命中，证据一律交给通用 helper 内部的
  // findActiveTabLabel 门禁（aria-selected=true 或 ant-tabs-tab-active）。
  await saveThenAdvance(page, {
    phase: "行程描述",
    targetTabLabel: "套餐管理",
    saveButtonNames: ["存为草稿"],
    targetTabLabels: ["套餐管理"],
    // VBK 行程描述页（tourdays）没有单独的「下一步」按钮，
    // 提交流程按钮统一是「提交审核并下一步」。
    nextButtonLabel: "提交审核并下一步",
    isTargetUrl: () => false,
    savedWith,
  });
  return { savedWith, days: product.itinerary.length };
}

async function chooseRadioValue(page, groupId, value, description) {
  const group = page.locator(`[id="${groupId}"]`);
  await assertCount(group, 1, description);
  const radio = group.locator(`input[type="radio"][value="${value}"]`);
  await assertCount(radio, 1, description);
  const parentClass = (await radio.locator("xpath=..").getAttribute("class")) ?? "";
  if (!parentClass.includes("ant-radio-checked")) {
    await radio.click({ force: true });
  }
}

export async function fillAndSavePackage(page, product) {
  // 套餐管理页面没有已确认的页面级「下一步」契约（用户保存后由后续
  // 价格库存阶段负责推进），本 helper 仅负责安全保存，不调用通用
  // saveThenAdvance，避免误点任何「下一步」按钮。
  if (!product.commercial) throw new Error("缺少 commercial 套餐配置");
  await clickSection(page, "套餐管理").catch(() => {});
  const existing = page.getByText(product.commercial.packageName, { exact: true });
  if (await existing.count()) return { skipped: "套餐已存在", packageName: product.commercial.packageName };
  await page
    .getByText("新增套餐", { exact: true })
    .waitFor({ state: "visible", timeout: 30_000 });
  const code = page.locator('[id="NewPackage_vendorResourceCode"]');
  await assertCount(code, 1, "供应商套餐编号");
  await code.fill(product.basicInfo.supplierProductCode);
  const description = page.locator('[id="NewPackage_description"]');
  await assertCount(description, 1, "套餐介绍");
  await description.fill(
    `${product.commercial.packageName}。${product.presentation?.recommendation ?? product.basicInfo.subtitle}`,
  );
  await chooseRadioValue(page, "NewPackage_isHotelResource", "T", "是否含酒店");
  await chooseRadioValue(page, "NewPackage_priceInputType", "1", "按人报价");
  await chooseRadioValue(page, "NewPackage_isHotelShareRoom", "F", "酒店拼房");
  await chooseRadioValue(page, "NewPackage_isContainBedFee", "F", "儿童占床");
  await chooseRadioValue(page, "NewPackage_needShuttle", "F", "接送备注");
  await chooseRadioValue(page, "NewPackage_isSmsVBKNotice", "T", "订单短信通知");
  const savedWith = await clickSafeSave(page, ["保存"]);
  return { savedWith, packageName: product.commercial.packageName };
}

function dateTitle(date) {
  const [year, month, day] = date.split("-").map(Number);
  return `${year}年${month}月${day}日`;
}

async function pickCalendarDate(page, input, date) {
  const title = dateTitle(date);
  await input.click();
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const target = page.locator(`td[title="${title}"]`);
    for (let index = 0; index < (await target.count()); index += 1) {
      if (await target.nth(index).isVisible()) {
        await target.nth(index).click();
        return;
      }
    }
    const next = page.locator('[title*="下个月"]');
    let advanced = false;
    for (let index = (await next.count()) - 1; index >= 0; index -= 1) {
      if (await next.nth(index).isVisible()) {
        await next.nth(index).click();
        advanced = true;
        break;
      }
    }
    if (!advanced) break;
  }
  throw new Error(`日期选择器无法定位 ${date}`);
}

async function fillVisibleInputs(locator, values, description) {
  const visible = [];
  for (let index = 0; index < (await locator.count()); index += 1) {
    if (await locator.nth(index).isVisible()) visible.push(locator.nth(index));
  }
  if (visible.length < values.length) {
    throw new Error(`${description}输入框不足：期望 ${values.length}，实际 ${visible.length}`);
  }
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] !== undefined) await visible[index].fill(String(values[index]));
  }
}

export async function fillAndSubmitPricingInventory(page, product, productId) {
  if (!product.commercial?.pricing || !product.commercial.inventory) throw new Error("缺少价格库存配置");
  const { pricing, inventory } = product.commercial;
  await page.goto(productSectionUrl(productId, "pricingInventory"), {
    waitUntil: "domcontentloaded",
  });
  await clickExact(page, "套餐价格库存");
  await clickExact(page, "设置价格/库存");
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ state: "visible", timeout: 15_000 });

  const rangeInputs = dialog.locator('input[readonly]');
  if ((await rangeInputs.count()) < 2) throw new Error("价格库存日期范围控件缺失");
  await pickCalendarDate(page, rangeInputs.nth(0), inventory.startDate);
  await pickCalendarDate(page, rangeInputs.nth(1), inventory.endDate);

  const allWeekdays = dialog.locator('input[type="checkbox"][value="all"]');
  if (await allWeekdays.count()) await ensureCheckboxChecked(allWeekdays.first());
  const limitStock = dialog.locator(
    'input[type="radio"][value="isLimit"], input[type="radio"][value="T"]',
  );
  if (await limitStock.count()) await limitStock.last().click({ force: true });

  const cost = pricing.cost ?? {
    adult: pricing.adult,
    child: pricing.child,
    singleSupplement: 0,
    childBed: 0,
  };
  const adultActual = dialog.locator("#adultActual");
  if (await adultActual.count()) {
    // 新版表单只允许维护底价；系统卖价由佣金规则自动计算。
    await adultActual.fill(String(cost.adult));
    await dialog.locator("#childActual").fill(String(cost.child));
    await dialog.locator("#diffActual").fill(String(cost.singleSupplement));
    await dialog.locator("#childOccupationBedActual").fill(String(cost.childBed));
    const quotaInputs = dialog.locator('input[type="number"]:not([id]):not([disabled])');
    await fillVisibleInputs(quotaInputs, [inventory.dailyQuota], "库存");
  } else {
    const numbers = dialog.locator('input[type="text"]:not([readonly]):not([disabled])');
    await fillVisibleInputs(
      numbers,
      [
        cost.adult,
        inventory.dailyQuota,
        cost.child,
        cost.singleSupplement,
        cost.childBed,
      ],
      "价格库存",
    );
  }
  const sendReview = dialog.getByRole("button", { name: /发.*审核/ });
  await sendReview.waitFor({ state: "visible", timeout: 10_000 });
  await sendReview.click();
  await dialog.waitFor({ state: "hidden", timeout: 15_000 });
  return {
    range: [inventory.startDate, inventory.endDate],
    dailyQuota: inventory.dailyQuota,
    submitted: true,
  };
}

export async function fillAndSaveTerms(page, product) {
  // 条款维护是录入末端阶段：本 helper 只安全保存，不调用通用
  // saveThenAdvance，绝不触碰任何「提审」/「提交审核」入口；
  // 真正的提审统一交给 submitProductReview。
  if (!product.commercial?.terms) throw new Error("缺少条款配置");
  await clickSection(page, "条款维护");
  const terms = product.commercial.terms;
  const textareas = page.locator("textarea");
  const values = [terms.inclusions, terms.exclusions, terms.bookingNotes, terms.refundPolicy];
  await fillVisibleInputs(textareas, values, "条款");
  return clickSafeSave(page, ["保存", "保存并下一步"]);
}

export async function ensureHotelResource(page, product, productId) {
  const hotelTier = product.operations?.hotelTier;
  const diamond = hotelDiamondFromTier(hotelTier);
  const needsHotel = product.itinerary?.some((day) => Boolean(day.hotel));
  if (!needsHotel) return { skipped: "行程不含住宿" };
  if (!diamond) throw new Error(`酒店等级配置无效：${String(hotelTier || "未配置")}`);

  await page.goto(productSectionUrl(productId, "vehicleResource"), {
    waitUntil: "domcontentloaded",
  });
  await page.getByText("资源配置", { exact: true }).waitFor({ timeout: 30_000 });

  // 住宿行程段才会出现“可添加：酒店”。从这个入口进入后，页面会自动带入
  // 行程段的城市 ID，再由酒店名称输入框调用 getSegmentHotelQueryList。
  const hotelEntries = page.getByText(/^(可添加：)?酒店$/, { exact: true });
  const hotelEntryCount = await hotelEntries.count();
  if (hotelEntryCount !== 1) {
    throw new Error(`可配置酒店的住宿行程段数量异常：期望 1，实际 ${hotelEntryCount}`);
  }
  await hotelEntries.first().click();
  await page.waitForURL(/\/newResourceRuleEdit\?.*resourcetype=hotel/i, { timeout: 15_000 });

  const specifiedHeader = page.getByRole("columnheader", { name: "排序分(由大到小排序)" });
  await specifiedHeader.waitFor({ state: "visible", timeout: 15_000 });
  const specifiedTable = page.locator("table").filter({ has: specifiedHeader });
  const configuredRows = specifiedTable.getByRole("row").filter({ hasNotText: "资源类型" }).filter({ hasNotText: "暂无内容" });
  const configuredTexts = (await configuredRows.allTextContents()).map((text) => text.replace(/\s+/g, " ").trim()).filter(Boolean);
  const existingHotel = product.operations?.hotelResource;
  const existingHotelId = existingHotel?.resourceId ? String(existingHotel.resourceId) : "";
  if (existingHotelId && existingHotel?.hotelTier === hotelTier && configuredTexts.some((text) => text.includes(existingHotelId))) {
    return { skipped: `已配置当地${diamond}钻酒店`, diamond, hotelTier };
  }
  if (configuredTexts.length) {
    throw new Error(`资源配置已有酒店，但与行程的当地${diamond}钻不一致：${configuredTexts.join("；")}`);
  }

  const addHotelButtons = page.getByRole("button", { name: /添加酒店/ });
  const addHotelButtonCount = await addHotelButtons.count();
  if (addHotelButtonCount !== 2) throw new Error(`“添加酒店”按钮数量异常：期望 2，实际 ${addHotelButtonCount}`);
  // 第一个属于“指定酒店”，第二个属于“屏蔽酒店”。
  await addHotelButtons.first().click();
  const dialog = page.getByRole("dialog", { name: "添加酒店" });
  await dialog.waitFor({ state: "visible", timeout: 10_000 });

  const combos = dialog.getByRole("combobox");
  const comboCount = await combos.count();
  if (comboCount !== 2) throw new Error(`酒店查询下拉框数量异常：期望 2，实际 ${comboCount}`);
  const hotelNameInput = combos.nth(1);
  await hotelNameInput.fill("");
  // Ant Select 的远程查询只响应真实键盘输入，fill() 不会触发接口。
  await hotelNameInput.type("酒店", { delay: 80 });

  const candidates = page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content");
  await candidates.first().waitFor({ state: "visible", timeout: 10_000 });
  const candidateTexts = (await candidates.allTextContents()).map((text) => text.replace(/\s+/g, " ").trim()).filter(Boolean);
  const selectedText = candidateTexts.find((text) => hotelCandidateMatchesTier(text, hotelTier));
  if (!selectedText) {
    throw new Error(`getSegmentHotelQueryList 未返回当地${diamond}钻酒店；已拒绝改选其它钻级。`);
  }
  const selectedOption = page.getByText(selectedText, { exact: true });
  const selectedOptionCount = await selectedOption.count();
  if (selectedOptionCount !== 1) throw new Error(`同钻级酒店候选无法唯一定位：${selectedText}`);
  await selectedOption.click();

  const query = dialog.getByRole("button", { name: "查 询" });
  await assertCount(query, 1, "酒店查询按钮");
  await query.click();
  await delay(700);
  const resultRows = dialog.getByRole("row").filter({ hasText: selectedText.split(" ")[0] });
  const resultRowCount = await resultRows.count();
  if (resultRowCount !== 1) throw new Error(`酒店查询结果数量异常：期望 1，实际 ${resultRowCount}`);
  const resultRow = resultRows.first();
  const resultText = (await resultRow.innerText()).replace(/\s+/g, " ").trim();
  if (!hotelCandidateMatchesTier(resultText, hotelTier)) {
    throw new Error(`酒店查询结果钻级不一致：行程为当地${diamond}钻，结果为 ${resultText}`);
  }
  const hotelId = resultText.match(/\b\d{4,}\b/)?.[0];
  if (!hotelId) throw new Error(`酒店查询结果缺少酒店 ID：${resultText}`);
  const checkbox = resultRow.getByRole("checkbox");
  await assertCount(checkbox, 1, "酒店结果选择框");
  await checkbox.check();
  const confirm = dialog.getByRole("button", { name: "确 定" });
  await assertCount(confirm, 1, "添加酒店确认按钮");
  await confirm.click();
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });

  const configured = specifiedTable.getByRole("row").filter({ hasText: hotelId });
  await configured.first().waitFor({ state: "visible", timeout: 10_000 });
  const configuredText = (await configured.first().innerText()).replace(/\s+/g, " ").trim();
  if (!configuredText.includes(hotelId)) throw new Error(`保存前复核失败：指定酒店 ID ${hotelId} 未进入配置表。`);
  const submit = page.getByRole("button", { name: "提 交", exact: true });
  await assertCount(submit, 1, "酒店资源提交按钮");
  await submit.click();
  return { source: "vbk", resourceId: Number(hotelId), resourceName: selectedText, diamond, hotelTier };
}

export async function ensureVehicleResource(page, product, productId) {
  const vehicle = product.operations?.vehicleResource;
  if (product.sales.productForm !== "privateTour") return { skipped: "非私家团" };
  if (!vehicle) throw new Error("私家团缺少 operations.vehicleResource 配置");
  await page.goto(productSectionUrl(productId, "vehicleResource"), {
    waitUntil: "domcontentloaded",
  });
  await page.getByText("资源配置", { exact: true }).waitFor({ timeout: 30_000 });
  const edit = page.getByRole("button", { name: "编 辑" });
  if (await edit.count()) {
    await edit.click();
    await delay(500);
  }

  const groupId = String(vehicle.resourceGroupId);
  const segmentResource = page.getByText(/^(可添加：)?附加资源$/, { exact: true }).first();
  await segmentResource.click();
  await delay(500);

  const existing = page.getByRole("row").filter({ hasText: groupId });
  if (!(await existing.count())) {
    // 用车组会直接影响客端价格，不能按城市或名称模糊猜测；只复用数据中
    // 明确指定、有效且已经过价格审查的现有资源组。
    const currentGroupRows = page
      .getByRole("row")
      .filter({ hasText: "度假可选项/用车" });
    for (let index = (await currentGroupRows.count()) - 1; index >= 0; index -= 1) {
      const remove = currentGroupRows.nth(index).getByText("删除", { exact: true });
      if (await remove.count()) await remove.click();
    }

    await page.getByRole("button", { name: /添加资源组/ }).click();
    const dialog = page.getByRole("dialog", { name: "选择资源组" });
    await dialog.waitFor({ state: "visible", timeout: 10_000 });
    await dialog.getByRole("textbox").nth(0).fill(groupId);
    await dialog.getByRole("button", { name: "查 询" }).click();
    await delay(700);
    const row = dialog.getByRole("row").filter({ hasText: groupId });
    if (!(await row.count())) throw new Error(`未找到现有用车资源组：${groupId}`);
    const rowText = (await row.innerText()).replace(/\s+/g, " ");
    if (!rowText.includes("有效")) throw new Error(`用车资源组不是有效状态：${rowText}`);
    if (!rowText.includes(vehicle.resourceGroupName)) {
      throw new Error(`用车资源组名称与产品数据不一致：${rowText}`);
    }
    await row.getByRole("radio").click();
    await dialog.getByRole("button", { name: "确 定" }).click();
  }

  await page.getByRole("button", { name: "提 交" }).click();
  await delay(700);
  await page.goto(productSectionUrl(productId, "vehicleResource"), {
    waitUntil: "domcontentloaded",
  });
  await page.getByRole("button", { name: "提交审核" }).click();
  const validation = page.getByRole("dialog", { name: "校验" });
  await validation.waitFor({ state: "visible", timeout: 10_000 });
  await validation.getByText(/校验结束/).waitFor({ timeout: 15_000 });
  const validationText = await validation.innerText();
  if (!validationText.includes("校验通过")) throw new Error(validationText);
  await validation.getByRole("button", { name: "确 定" }).click();
  return { resourceGroupId: vehicle.resourceGroupId, audited: true };
}

export async function runProductPreflight(page, product, productId) {
  if (!product.commercial) throw new Error("缺少 commercial 配置");
  if (product.commercial.inventory && product.commercial.pricing) {
    const { startDate, endDate, dailyQuota } = product.commercial.inventory;
    if (new Date(startDate) > new Date(endDate)) throw new Error("库存开始日期晚于结束日期");
    if (dailyQuota < product.commercial.pricing.minimumTravelers) {
      throw new Error("每日库存小于最低成团人数");
    }
  }
  if (product.sales.productForm === "privateTour") {
    const groupId = product.operations?.vehicleResource?.resourceGroupId;
    if (!groupId) throw new Error("私家团未配置现有用车资源组 ID");
  }
  await page.goto(productEditorUrl(productId), { waitUntil: "domcontentloaded" });
  const body = await page.locator("body").innerText();
  if (!body.includes(String(productId))) throw new Error("产品详情页未加载目标产品");
  return { productId: String(productId), commercialData: "ok" };
}

export async function submitProductReview(page, product) {
  if (!product.commercial?.release.submitReview) return { skipped: "数据配置为不提审" };
  const button = page.getByRole("button", { name: "提交审核", exact: true });
  if (!(await button.count())) {
    return { submitted: true, mode: "各模块已在对应阶段提交审核" };
  }
  await button.waitFor({ state: "visible", timeout: 30_000 });
  await button.click();
  await delay(1_500);
  return { submitted: true };
}

async function findProductRow(page, productId) {
  const row = page.locator("tbody tr").filter({ hasText: String(productId) });
  await row.first().waitFor({ state: "visible", timeout: 30_000 });
  return row.first();
}

async function queryProductRow(page, productId) {
  await page.goto(URLS.list, { waitUntil: "domcontentloaded" });
  const allTab = page.getByText("全部", { exact: true }).first();
  if (await allTab.count()) await allTab.click();
  const idSearch = page.getByRole("textbox", { name: "多个用英文逗号分隔" });
  await idSearch.fill(String(productId));
  await page.getByRole("button", { name: "查 询" }).click();
  await delay(700);
  return findProductRow(page, productId);
}

async function acknowledgeResult(page, expectedText) {
  const dialog = page.getByRole("dialog").filter({ hasText: expectedText });
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  const text = await dialog.innerText();
  if (!text.includes(expectedText)) throw new Error(text);
  await dialog.getByRole("button", { name: "知道了" }).click();
}

export async function publishProduct(page, product, productId) {
  if (!product.commercial?.release.publishAfterApproval) return { skipped: "数据配置为不上线" };
  let row = await queryProductRow(page, productId);
  const makeValid = row.getByText("设为有效", { exact: true });
  if (await makeValid.count()) {
    await makeValid.click();
    await acknowledgeResult(page, "操作成功");
    row = await queryProductRow(page, productId);
  }

  let status = (await row.innerText()).replace(/\s+/g, " ");
  if (!isOnlineStatus(status)) {
    await ensureCheckboxChecked(row.getByRole("checkbox"));
    await page.getByRole("button", { name: "批量上线" }).click();
    await acknowledgeResult(page, "批量上线处理成功");
    row = await queryProductRow(page, productId);
    status = (await row.innerText()).replace(/\s+/g, " ");
  }
  if (!isValidStatus(status) || !isOnlineStatus(status)) {
    throw new Error(`发布状态未达到“有效/上线”：${status}`);
  }
  return { published: true, status: "有效/上线" };
}

export async function auditPublishedProduct(page, product, productId) {
  const row = await queryProductRow(page, productId);
  const status = (await row.innerText()).replace(/\s+/g, " ");
  if (!isValidStatus(status) || !isOnlineStatus(status)) {
    throw new Error(`上线后检查失败：${status}`);
  }
  await page.goto(productSectionUrl(productId, "pricingInventory"), {
    waitUntil: "domcontentloaded",
  });
  const pricingText = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  const cost = product.commercial.pricing.cost;
  // cost 是可选的；缺失时不能拼出 "…/undefined" 这种永远匹配不到的断言，
  // 只核验能确定的库存与已给出的价格。
  const expected = [
    ...(cost?.adult === undefined ? [] : [`${product.commercial.pricing.adult}/${cost.adult}`]),
    ...(cost?.child === undefined ? [] : [`${product.commercial.pricing.child}/${cost.child}`]),
    `0/${product.commercial.inventory.dailyQuota}`,
  ];
  for (const value of expected) {
    if (!pricingText.includes(String(value))) throw new Error(`上线后未核验到价格/库存值：${value}`);
  }

  const publicUrl = `https://vacations.ctrip.com/travel/detail/p${productId}/`;
  const ceiling = product.commercial.release.publicPriceCeiling;
  const retries = product.commercial.release.publicAuditRetries;
  let repaired = false;
  let publicPrices = [];
  let publicText = "";
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    await page.goto(`${publicUrl}?vbkAudit=${Date.now()}`, { waitUntil: "domcontentloaded" });
    await delay(1_200);
    publicText = await page.locator("body").innerText();
    publicPrices = [...publicText.matchAll(/(?:¥|￥)?(\d+)起/g)].map((match) => Number(match[1]));
    const outliers = publicPrices.filter((price) => price > ceiling);
    if (
      publicText.includes(String(productId)) &&
      publicPrices.length > 0 &&
      outliers.length === 0
    ) {
      return {
        productId: String(productId),
        status: "有效/上线",
        priceInventory: "verified",
        publicUrl,
        publicPrices: [...new Set(publicPrices)],
        repaired,
      };
    }
    if (!repaired && outliers.length) {
      // 资源组变更后，携程的逐日聚合价偶尔保留旧缓存。重发同一组
      // 价格库存可触发全部班期重新聚合，之后再做客端检查。
      await fillAndSubmitPricingInventory(page, product, productId);
      repaired = true;
    }
    await delay(5_000);
  }
  throw new Error(
    `上线后客端价格检查失败：上限 ${ceiling}，检测价格 ${publicPrices.join("、") || "无"}`,
  );
}

export async function fillBasicInfo(page, product, butlerSelection, extra = {}) {
  const info = product.basicInfo;
  await page.getByText("基本信息", { exact: true }).waitFor();
  // 线上 400 电话：来自账号固定信息（servicePhone），在 VBK 下拉里精确选择；
  // 缺失或找不到时由 fillServicePhone 直接抛错，禁止默认第一项。
  const servicePhone = typeof extra?.servicePhone === "string" ? extra.servicePhone.trim() : "";
  await fillServicePhone(page, servicePhone);

  const numberInputs = page.locator("input.ant-input-number-input");
  const numberInputCount = await numberInputs.count();
  if (numberInputCount < 2) {
    throw new Error(`天/晚输入框结构异常：仅找到 ${numberInputCount} 个数字输入框`);
  }
  await numberInputs.nth(0).fill(String(info.days));
  await numberInputs.nth(1).fill(String(info.nights));

  await fillById(page, "baseInfo.subName", info.subtitle, "副标题输入框");
  await fillById(
    page,
    "baseInfo.providerProductName",
    info.supplierProductName,
    "供应商产品名称输入框",
  );
  await fillById(
    page,
    "baseInfo.vendorProductCode",
    info.supplierProductCode,
    "供应商产品编号输入框",
  );
  await fillById(
    page,
    "baseInfo.operationNote",
    info.operationNotes,
    "操作说明输入框",
  );

  // 国内省份非空时，集合城市和目的城市都必须严格匹配“中国-${city}”，
  // 防止把“大同”错绑到同名“朝鲜-大同”。未配置省份（如海外行程）走老路径。
  const preferredCountry = info.province && info.province.trim() ? "中国" : undefined;
  // AI 兜底仅在「ambiguous / 存在同名不同上级」场景下被调用；未传 disambiguator
  // 时仍走原严格匹配路径，所以这里仅走透传，不改默认语义。
  const cityContext = { disambiguator: extra?.disambiguator, product };
  await fillCitySelect(page, "baseInfo.masterDepartureCityId", info.meetingCity, preferredCountry, cityContext);
  await fillCitySelect(page, "baseInfo.destinationCityID", info.destinationCity, preferredCountry, cityContext);
  await fillProductLine(page, info.destinationCity, info.province);

  // 国家景区：从 basicInfo.province 取值，自动在 #scenic_area 容器内或标签
  // 「省」关联的下拉里点选。已存在的同省份条目不再重复添加。
  if (info.province) await fillScenicAreaProvince(page, info.province, cityContext);
  // 国家景区内的具体景点：取 product 行程里确定性筛出的最多 3 个重点景点，
  // 在同一容器内逐个搜索并点选。spotLogs 由调用方传入，未命中的单项只记录
  // 日志、绝不允许默认第一项；不足 3 个时按实际匹配数量添加。
  const scenicSpotLogs = Array.isArray(extra?.scenicSpotLogs) ? extra.scenicSpotLogs : [];
  if (info.province && Array.isArray(extra?.keySpots) && extra.keySpots.length) {
    await fillScenicAreaSpots(page, info.province, extra.keySpots, scenicSpotLogs, cityContext);
  }
  // 提前预订：通过 schema.resolveAdvanceBooking 拿到合法配置（缺失时回落 1 天 12:00），
  // 然后准确定位 label[for=bookingControls.advanceBooking] 关联的 .ant-form-item
  // 再分别填天数与时间，避开行程天/晚等 number input。
  const advance = resolveAdvanceBooking(product);
  if (advance) await fillAdvanceBooking(page, advance);
  // 地接社：打开 bookingControls.localInfoIds 下拉后选择第一个可用且非 disabled
  // 的选项。无任何可用项直接报错，不再做前置 blocker。
  await fillLocalTravelAgency(page);
  // 管家联系人：调用方从账号固定信息中读取后传入；按 contactCardId 精确匹配
  // 失败按 displayName 匹配；都不命中抛错，不默认第一项。
  if (butlerSelection) await fillButlerContact(page, butlerSelection);
}

/**
 * 国家景区 / 省 下拉：定位到 #scenic_area 容器内的「省」label，打开下拉后
 * 用 schema.findProvinceOptionIndex 匹配省份文本；点击后视情点「添加」，
 * 已有相同省份时不再重复添加。
 */
async function fillScenicAreaProvince(page, province, extra = {}) {
  const disambiguator = extra?.disambiguator;
  const product = extra?.product ?? {};
  const label = (province || "").trim();
  if (!label) throw new Error("国家景区（省份）未配置，无法继续录入。");
  const container = page.locator("#scenic_area");
  await assertCount(container, 1, "国家景区容器 #scenic_area");
  // 已添加项是形如“中国山西”的 .ant-tag，不会与单独的“山西”精确文本
  // 匹配。重试时先检查 tag，避免再次点击“添加”触发重复地区弹窗。
  const provinceBase = label.replace(/(维吾尔自治区|壮族自治区|回族自治区|特别行政区|自治区|省|市)$/g, "");
  const addedTags = (await container.locator(".ant-tag").allTextContents())
    .map((text) => text.replace(/\s+/g, ""));
  if (addedTags.some((text) => text.includes(provinceBase))) return;
  const comboboxes = container.getByRole("combobox");
  const comboboxCount = await comboboxes.count();
  if (comboboxCount < 2) {
    throw new Error(`国家景区级联下拉结构异常：仅找到 ${comboboxCount} 个下拉框`);
  }
  // 选项挂在 body 上的旧 Ant Select 弹层；同时兼容 .ant-select-item-option 与
  // 旧版的 .ant-select-dropdown-menu-item。
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

  // 国内省份远程搜索结果自带国家归属（例如“山西 中国”），无需先输入
  // 或选择“中国”；直接从省份框精确选择即可。

  await comboboxes.nth(1).click();
  const provinceSearch = comboboxes.nth(1).locator("input.ant-select-search__field");
  await assertCount(provinceSearch, 1, "省份搜索输入框");
  await provinceSearch.fill("");
  await provinceSearch.type(label, { delay: 80 });
  const provinces = await availableOptions("省份");
  const texts = provinces.texts;
  const disableds = provinces.disableds;
  // 先按本地省份规则匹配（处理“中国-山西”与“山西”这类差异），未命中再
  // AI 兜底。AI 只为“能近似”的项投票，不接受「勉强选一个」。
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
  void chosenSource; // 目前只用于日志
  await optionNodes.nth(chosenIndex).click();
  await delay(300);
  // 「添加」按钮：仅在省份确认添加后才生效。同一省份已存在时不能再点。
  const addButton = container.getByRole("button", { name: "添加", exact: true }).first();
  if (await addButton.count()) {
    const alreadyAdded = await container.getByText(label, { exact: true }).count();
    if (alreadyAdded <= 1) await addButton.click();
  }
  // 数据风险弹窗只对“景点”跳过；省份被拒说明 AI/精确匹配选中了
  // 境外同名项，代码路径不允许静默放过，必须报错让用户/上轮接手。
  const dataRisk = await dismissDataRiskDialog(page);
  if (dataRisk) {
    throw new Error(
      `省下拉疑似选中了境外项：${dataRisk}。这是 VBK 的阻断式反馈，请检查 VBK 中是否手动选过其他国家的省份。`,
    );
  }
  await delay(300);
}

/**
 * 线上 400 电话：定位「线上 400 电话」label 关联的 .ant-form-item 内的
 * combobox；下拉打开后用「精确匹配」挑出与账号固定信息 servicePhone 完全
 * 一致的选项；找不到（包含空字符串 / Not Found / disabled）一律抛错，
 * 绝不允许默认第一项。phone 为空时直接抛错。
 */
async function fillServicePhone(page, phone) {
  const target = (phone || "").trim();
  if (!target) throw new Error("线上 400 电话（servicePhone）未配置，无法继续录入。");
  const labelLocator = page.locator("label[for=\"baseInfo.phone400\"]");
  await assertCount(labelLocator, 1, "线上 400 电话 label[for=baseInfo.phone400]");
  const formItem = labelLocator.locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' ant-form-item ')][1]");
  await assertCount(formItem, 1, "线上 400 电话 .ant-form-item");
  await formItem.waitFor({ state: "visible", timeout: 10_000 });
  // Electron WebContentsView 下 window.innerHeight 可能为 0，Playwright 的
  // auto-scroll 会跟不动并超时 30s。手动滚 form-item 到视口中央：
  // 表单外层 .ant-form 可滚，先判断滚动原点（documentElement vs form 容器），
  // 都试一下使能跨浏览器场景。
  await page.evaluate(() => {
    const el = document.querySelector('label[for="baseInfo.phone400"]')?.closest('.ant-form-item');
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.top < 0 || rect.bottom > (window.innerHeight || document.documentElement.clientHeight || 0)) {
      el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      // 上面可能不够：手写「绝对滚动到 center」避免 form 容器 scrollTop 错位
      const form = document.querySelector('.ant-form');
      if (form && form.scrollHeight > form.clientHeight) {
        form.scrollTop = Math.max(0, el.offsetTop - form.clientHeight / 2);
      }
      const main = document.querySelector('.vbk_layout_layout-main');
      if (main && main.scrollHeight > main.clientHeight) {
        main.scrollTop = Math.max(0, el.offsetTop - main.clientHeight / 2);
      }
    }
  });
  const trigger = formItem.locator(".ant-select-selection[role='combobox']");
  await assertCount(trigger, 1, "线上 400 电话 combobox");
  await trigger.click();
  await delay(400);
  const options = page.locator(
    ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option, " +
    ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-dropdown-menu-item",
  );
  await options.first().waitFor({ state: "visible", timeout: 8_000 }).catch(() => {});
  const total = await options.count();
  const texts = (await options.allTextContents()).map((text) => text.trim());
  const disableds = await Promise.all(
    Array.from({ length: total }, async (_, index) => {
      const cls = (await options.nth(index).getAttribute("class")) || "";
      return /ant-select-item-disabled|ant-select-dropdown-menu-item-disabled/.test(cls);
    }),
  );
  const matchIndex = texts.findIndex((text, index) => text === target && !disableds[index]);
  if (matchIndex < 0) {
    throw new Error(`线上 400 电话下拉未找到「${target}」；可选：${texts.filter(Boolean).join("、") || "无"}`);
  }
  await options.nth(matchIndex).click();
  await delay(300);
}

/**
 * 国家景区级联：已添加省份后，对给定的「重点景点」列表逐个在 #scenic_area
 * 容器内打开景点下拉、搜索、点选并按需「添加」。已存在的同名景点跳过。
 * 命中失败的单项只追加日志到 logs（由调用方落盘），绝不默认第一项。
 * 容器/下拉结构与 fillScenicAreaProvince 保持一致。
 */
async function fillScenicAreaSpots(page, province, spots, logs = [], extra = {}) {
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
    // 这里传入的 combobox 本身就是旧版 Ant Select 的
    // .ant-select-selection 节点，不再向内查找同名子节点。
    await combobox.click();
    const search = combobox.locator("input.ant-select-search__field");
    await assertCount(search, 1, `${description}搜索输入框`);
    await search.waitFor({ state: "visible", timeout: 5_000 });
    await search.fill("");
    await search.type(target, { delay: 80 });
    const deadline = Date.now() + 8_000;
    let last: string[] = [];
    let lastDisableds: boolean[] = [];
    while (Date.now() < deadline) {
      const count = await options.count();
      // textContent 会把“柳巷”与“太原/山西/中国”直接粘连；使用
      // innerText 保留页面可见换行，再取第一行作为候选名称。
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
    // 轮询结束仍未精确命中：进入 AI 兜底。
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

    // 国内行程不输入国家、省份或城市。先直接在“景点”层搜索；如果该
    // 名称在 VBK 被归类为景区，再回退到“城市/景区”层搜索同名项。
    let selected = await chooseExact(comboboxes.nth(3), spot, spotAliases, "景点");
    if (!selected) {
      selected = await chooseExact(comboboxes.nth(2), spot, spotAliases, "城市/景区（景区）");
    }
    if (!selected) {
      logs.push(`[warn] 景点或景区“${spot}”均未找到精确选项，已跳过`);
      continue;
    }
    const addButton = container.getByRole("button", { name: "添加", exact: true }).first();
    if (await addButton.count()) {
      await addButton.click().catch(() => {});
    }
    // 「数据风险」是 VBK 对「添加境外同名项」的拦截：原因=途径地
    // 朝鲜 且 产品类型 境内短途旅游。设计上是“不能不填”以外的跳出门
    // 槛：用户明确要求遇到该弹窗就跳过该景点，这里点「确定/我知道了」
    // 关闭弹窗、记录警告日志、不报错。下一轮景点仍会接着尝试。
    const dataRisk = await dismissDataRiskDialog(page);
    if (dataRisk) {
      logs.push(`[warn] 景点“${spot}”添加触发数据风险弹窗（${dataRisk}），疑似境外同名项，已跳过该景点`);
      // 保证景区下拉被收起，否则下一个景点的 combobox.click() 会被旧弹层拦截。
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
      // 等待期间也可能漂出数据风险弹窗（例如 form 提交后才出现）；
      // 同样点“确定”关掉，不让下一轮选点被拦截。
      if (await dismissDataRiskDialog(page, 200)) break;
      await delay(200);
    }
    if (!committed) {
      const again = await dismissDataRiskDialog(page, 500);
      if (again) {
        logs.push(`[warn] 景点“${spot}”提交后弹出数据风险弹窗（${again}），已跳过该景点`);
        continue;
      }
      throw new Error(`景点“${spot}”已选择但未成功添加到国家景区标签。`);
    }
  }
}

/**
 * 提前预订：通过 label[for=bookingControls.advanceBooking] 准确定位最近
 * 的 .ant-form-item，再分别填天数（input.ant-input-number-input）和时间
 * （input.ant-time-picker-input，placeholder 是「请选择」）。三者唯一性
 * 由 assertCount 兜底，避免误伤行程天/晚等其它 number input。
 */
async function fillAdvanceBooking(page, { days, time }) {
  const labelLocator = page.locator("label[for=\"bookingControls.advanceBooking\"]");
  await assertCount(labelLocator, 1, "提前预订 label[for=bookingControls.advanceBooking]");
  const formItem = labelLocator.locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' ant-form-item ')][1]");
  await assertCount(formItem, 1, "提前预订 .ant-form-item");
  await formItem.waitFor({ state: "visible", timeout: 10_000 });
  const dayInput = formItem.locator("input.ant-input-number-input");
  await assertCount(dayInput, 1, "提前预订天数输入框");
  await dayInput.fill(String(days));
  const timeInput = formItem.locator("input.ant-time-picker-input");
  await assertCount(timeInput, 1, "提前预订时间输入框");
  const [hour, minute] = String(time).split(":");
  if (!hour || !minute) throw new Error(`提前预订时间格式异常：${time}`);
  // 旧版 Ant TimePicker 是受控组件，直接 fill() 会在失焦时被 React 清空。
  // 必须打开面板，依次点选小时和分钟才能触发 onChange 并持久化值。
  await timeInput.click();
  const panel = page.locator(".ant-time-picker-panel:visible");
  await panel.waitFor({ state: "visible", timeout: 5_000 });
  const columns = panel.locator(".ant-time-picker-panel-select");
  const columnCount = await columns.count();
  if (columnCount < 2) throw new Error(`提前预订时间面板结构异常：仅找到 ${columnCount} 列`);
  const hourOption = columns.nth(0).locator("li").filter({ hasText: new RegExp(`^${hour}$`) });
  await assertCount(hourOption, 1, `提前预订小时 ${hour}`);
  await hourOption.click();
  const minuteOption = columns.nth(1).locator("li").filter({ hasText: new RegExp(`^${minute}$`) });
  await assertCount(minuteOption, 1, `提前预订分钟 ${minute}`);
  await minuteOption.click();
  await delay(200);
  const committed = await timeInput.inputValue();
  if (committed !== time) throw new Error(`提前预订时间未成功提交：期望 ${time}，实际 ${committed || "空"}`);
}

/**
 * 地接社名称：定位 div[id=bookingControls.localInfoIds]（同 id 还有 input，
 * 必须限定 div），打开后用 pickFirstEnabledLocalInfoIndex 选第一个可用且
 * 非 disabled 的选项；无任何可用项直接报错。
 */
async function fillLocalTravelAgency(page) {
  const scope = page.locator("div[id=\"bookingControls.localInfoIds\"]");
  await assertCount(scope, 1, "地接社容器 div#bookingControls.localInfoIds");
  await scope.waitFor({ state: "visible", timeout: 10_000 });
  // 这是多选控件，阶段重试不能在旧选择后继续追加。先逐项清空，随后只
  // 选择下拉里的第一个可用项。
  const selectedChoices = scope.locator(".ant-select-selection__choice");
  while (await selectedChoices.count()) {
    const lastChoice = selectedChoices.nth((await selectedChoices.count()) - 1);
    const remove = lastChoice.locator(".ant-select-selection__choice__remove");
    await assertCount(remove, 1, "地接社已选项删除按钮");
    // 删除一个标签会立即重绘整个多选框，常规 click 会因节点 detached
    // 自动重试直至超时；force 点击当前删除按钮后马上重新查询下一项。
    await remove.click({ force: true });
    await delay(150);
  }
  // 该控件只有内部搜索输入框获得光标后才会展示下拉，不能只点外层。
  const searchInput = scope.locator("input.ant-select-search__field");
  await assertCount(searchInput, 1, "地接社搜索输入框");
  await searchInput.click();
  await delay(400);
  // 兼容旧 Ant Select 的两种选项 class。
  const options = page.locator(
    ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option, " +
    ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-dropdown-menu-item",
  );
  await options.first().waitFor({ state: "visible", timeout: 8_000 });
  const total = await options.count();
  const texts = (await options.allTextContents()).map((text) => text.trim());
  const disableds = await Promise.all(
    Array.from({ length: total }, async (_, index) => {
      const cls = (await options.nth(index).getAttribute("class")) || "";
      return /ant-select-item-disabled|ant-select-dropdown-menu-item-disabled/.test(cls);
    }),
  );
  const targetIndex = findFirstEnabledOptionIndex(texts, disableds);
  if (targetIndex < 0) {
    throw new Error(`地接社下拉无可用项；请先在 VBK 维护地接社。可选：${texts.filter(Boolean).join("、") || "无"}`);
  }
  await options.nth(targetIndex).click();
  const commitDeadline = Date.now() + 3_000;
  while (Date.now() < commitDeadline && (await selectedChoices.count()) !== 1) {
    await delay(150);
  }
  if ((await selectedChoices.count()) !== 1) {
    throw new Error(`地接社第一项“${texts[targetIndex]}”点击后未成功写入。`);
  }
  const committedText = (await selectedChoices.nth(0).innerText()).trim();
  if (!committedText.includes(texts[targetIndex])) {
    throw new Error(`地接社选中项异常：期望“${texts[targetIndex]}”，实际“${committedText || "空"}”`);
  }
}

/**
 * 管家联系人：用 schema.findButlerOptionIndex 优先按 contactCardId 精确
 * 匹配，失败回退到 displayName；都不命中抛错，绝不默认第一项。
 *
 * 容器定位：携程真实 DOM 中 bookingControls.vendorBookingAssistant 同 id
 * 还挂在隐藏的 input 上，必须显式限定 div，否则 input 也会命中而让
 * assertCount 失败。容器内的 combobox 与 input.ant-select-search__field
 * 都要求唯一（assertCount 1），不使用 first 逃避歧义。
 */
async function fillButlerContact(page, selection) {
  if (!selection || typeof selection !== "object") {
    throw new Error("管家联系人未配置账号固定信息，请在账号设置里维护后重试。");
  }
  const { contactCardId, displayName } = selection;
  if (!Number.isInteger(contactCardId) || contactCardId <= 0) {
    throw new Error("管家联系人 contactCardId 缺失或非法。");
  }
  const scope = page.locator('div[id="bookingControls.vendorBookingAssistant"]');
  await assertCount(scope, 1, "管家联系人容器 div#bookingControls.vendorBookingAssistant");
  await scope.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
  const trigger = scope.getByRole("combobox");
  await assertCount(trigger, 1, "管家联系人 combobox");
  await trigger.click();
  await delay(400);
  const search = scope.locator("input.ant-select-search__field");
  await assertCount(search, 1, "管家联系人搜索输入框");
  if (displayName) await search.fill(displayName);
  await delay(400);
  // 兼容旧 Ant Select 的两种选项 class。
  const options = page.locator(
    ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option, " +
    ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-dropdown-menu-item",
  );
  await options.first().waitFor({ state: "visible", timeout: 8_000 });
  const total = await options.count();
  const collected = await Promise.all(
    Array.from({ length: total }, async (_, index) => {
      const text = (await options.nth(index).innerText().catch(() => "")).replace(/\s+/g, " ").trim();
      const value = await options.nth(index).getAttribute("data-value").catch(() => null);
      const id = await options.nth(index).getAttribute("data-id").catch(() => null);
      return { value: String(value || id || ""), label: text };
    }),
  );
  const targetIndex = findButlerOptionIndex(collected, { contactCardId, displayName });
  if (targetIndex < 0) {
    const texts = collected.map((option) => option.label);
    throw new Error(`管家联系人下拉未找到 ID ${contactCardId}${displayName ? ` / ${displayName}` : ""}；可选：${texts.filter(Boolean).join("、") || "无"}`);
  }
  await options.nth(targetIndex).click();
  await delay(300);
}

/**
 * 保存后校验：扫描 .ant-form-item-with-help 与包含 .ant-form-item-control.has-error
 * 的表单项，按 label 去重后报告四项基本页目标（国家景区 / 提前预订 /
 * 地接社 / 管家）红错。basic 阶段的「下一步」已由通用 saveThenAdvance
 * 负责，本函数只读页面状态；不再负责点「保存」、「下一步」、提交审核或
 * 发布。
 *
 * watcher → 填表函数一一对应表：
 *   "国家景区"   ⇒  fillScenicAreaProvince / fillScenicAreaSpots
 *   "提前预订"   ⇒  fillAdvanceBooking
 *   "地接社"     ⇒  fillLocalTravelAgency
 *   "管家"       ⇒  fillButlerContact
 * 任何一项改了页面结构（class名、必填标记、提交逻辑），请同步调整上面
 * 的填表函数与这里 watched 列表；不全表则红错遗漏→人工发现代价大。
 */
async function assertBasicInfoNoRedErrors(page) {
  await delay(800);
  const watched = ["国家景区", "提前预订", "地接社", "管家"];
  const withHelp = page.locator(".ant-form-item-with-help");
  const withControlError = page.locator(".ant-form-item:has(.ant-form-item-control.has-error)");
  const total = (await withHelp.count()) + (await withControlError.count());
  if (!total) return;
  const seen = new Set();
  const labels: string[] = [];
  async function consider(locator: ReturnType<typeof page.locator>) {
    const count = await locator.count();
    for (let index = 0; index < count; index += 1) {
      const item = locator.nth(index);
      const text = (await item.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
      if (!text) continue;
      if (!watched.some((keyword) => text.includes(keyword))) continue;
      const labelKey = watched.find((keyword) => text.includes(keyword)) || text.slice(0, 32);
      if (seen.has(labelKey)) continue;
      seen.add(labelKey);
      labels.push(labelKey);
    }
  }
  await consider(withHelp);
  await consider(withControlError);
  if (labels.length) throw new Error(`基本信息仍有红色校验项：${labels.join("、")}`);
}

export async function saveScreenshot(page, prefix, productId = "preview") {
  const artifactDir = path.resolve(ARTIFACTS_DIR);
  await fs.mkdir(artifactDir, { recursive: true });
  const filename = `${prefix}-${productId}-${Date.now()}.png`;
  const target = path.join(artifactDir, filename);
  await page.screenshot({ path: target, fullPage: false });
  return target;
}
