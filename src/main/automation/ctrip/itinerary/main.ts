// @ts-nocheck
/**
 * 行程描述（itinerary）面板自动化主入口：fillItineraryDraft。
 *   - 先确保跳到产品编辑页并点开「行程描述」tab，等到 title textarea 行数 == itinerary.length；
 *   - 按 day 循环：填标题 / 包车选项 / 接送站 / 餐食 / 酒店 / 服务时间 / 其他节点补充说明；
 *   - 全部天填完后点「存为草稿」并经 saveThenAdvance 等「套餐管理」tab 解锁（提交审核并下一步）。
 * 顶部带 `// @ts-nocheck`，disambiguator 由 caller 注入。
 */

import { delay, pollUntil, assertCount } from "../utils.js";
import { clickSection, clickSafeSave, saveThenAdvance } from "../tabs.js";
import { productEditorUrl } from "../../constants.js";
import { dayScopeFor, ensureOtherCard, ensureServiceTimeRange, clickExact } from "./common.js";
import { fillHotelCard, fillMealCards } from "./cards.js";
import { fillPickupAndDropoff, handleAirportTrainModal } from "./stations.js";
import { ensureItinerarySpotsApi } from "../itinerary-api.js";

const FIRST_DAY_DESCRIPTION_REPLACEMENTS = [
  { term: "巅峰", replacement: "高峰" },
] as const;

function normalizeFirstDayItineraryDescription(day) {
  if (Number(day?.day) !== 1 || typeof day?.description !== "string") return day?.description ?? "";
  return FIRST_DAY_DESCRIPTION_REPLACEMENTS.reduce((next, { term, replacement }) => next.split(term).join(replacement), day.description);
}

/**
 * 行程描述阶段「套餐管理」URL 命中常量（导出供测试断言使用）：
 *   - 真实 VBK 跳转目标 URL 形如：
 *       https://vbooking.ctrip.com/ivbk/vendor/packageManage?productid=...&from=vbk
 *   - 必须 protocol === "https:"、hostname === "vbooking.ctrip.com"、
 *     pathname === PACKAGE_MANAGE_PATH（完全相等，不含尾斜杠 / 子路径）、
 *     端口为默认端口（无显式 :port）。
 *   - query 段不参与判定（任意 query 都允许）。
 *   - 拒绝 packageManageList / baseInfoMerge / 其他 origin / 中文 tab 名 /
 *     仅 query 含 packageManage 关键字的中间页 / 带非默认端口 / 子域名伪装等。
 */
export const PACKAGE_MANAGE_ORIGIN = "https://vbooking.ctrip.com";
export const PACKAGE_MANAGE_HOSTNAME = "vbooking.ctrip.com";
export const PACKAGE_MANAGE_PATH = "/ivbk/vendor/packageManage";
export const PACKAGE_MANAGE_PROTOCOL = "https:";

/**
 * 判定 url 字符串是否对应 VBK 套餐管理页。
 *   - 只接受协议 https: + hostname 严格 vbooking.ctrip.com + pathname 严格
 *     /ivbk/vendor/packageManage + 默认端口（无显式 :port）的组合；query
 *     任意（保留 productid 等）。
 *   - 拒绝尾斜杠 / 子路径 / 相似路径段（packageManageList 等）。
 *   - 拒绝带端口 / 子域名伪装 / http / 中文 tab 名等任何偏离。
 *   - 非字符串 / 空串 / 解析失败 / 任一字段不匹配：返回 false（不抛错）。
 *
 * @param {unknown} url Playwright `page.url()` 返回值（绝对 URL 字符串）。
 * @returns {boolean}
 */
export function isPackageManageUrl(url) {
  if (typeof url !== "string" || !url) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== PACKAGE_MANAGE_PROTOCOL) return false;
  if (parsed.hostname !== PACKAGE_MANAGE_HOSTNAME) return false;
  // 端口必须为默认（无显式 :port，避免 :8080 / :443 拼出错误 origin 还能混过去）。
  if (parsed.port && parsed.port !== "") return false;
  if (parsed.pathname !== PACKAGE_MANAGE_PATH) return false;
  return true;
}

/**
 * 行程描述面板写入主函数。返回 { savedWith, days }。
 *   - 上方空行（标题还没渲染）时主动 jump + clickSection + 轮询；
 *   - 包车与否由 operations.transport === "charter" 决定；
 *   - 第 0 天的「其他」card 默认排在最前（afterFirstCard=true），其它天追加；
 *   - 全部填完走「存为草稿 + 提交审核并下一步」二段提交。
 */
export async function fillItineraryDraft(page, product, options = {}) {
  const disambiguator = options?.disambiguator;
  const productId = options?.productId || product.productId || "";
  const normalizedProduct = {
    ...product,
    itinerary: Array.isArray(product?.itinerary)
      ? product.itinerary.map((day) =>
          typeof day?.description === "string" ? { ...day, description: normalizeFirstDayItineraryDescription(day) } : day,
        )
      : [],
  };
  const normalizedDays = Array.isArray(normalizedProduct?.itinerary) ? normalizedProduct.itinerary : [];
  let titleInputs = page.locator('textarea[placeholder^="请输入标题"]');
  if ((await titleInputs.count()) !== normalizedDays.length) {
    await page.goto(productEditorUrl(productId), { waitUntil: "domcontentloaded" });
    titleInputs = page.locator('textarea[placeholder^="请输入标题"]');
  }
  if ((await titleInputs.count()) !== normalizedDays.length) {
    await clickSection(page, "行程描述");
    titleInputs = page.locator('textarea[placeholder^="请输入标题"]');
  }
  const titleReady = await pollUntil(
    titleInputs,
    (loc) => loc.count().then((n) => n === product.itinerary.length),
    3_000,
  );
  if (!titleReady) {
    await assertCount(titleInputs, product.itinerary.length, "每日标题输入框");
  }

  for (let index = 0; index < normalizedDays.length; index += 1) {
    const day = normalizedDays[index];
    const titleInput = titleInputs.nth(index);
    await titleInput.fill(day.title);
    const titleAfterFill = (await titleInput.inputValue()).trim();
    if (!titleAfterFill) {
      throw new Error(`第 ${day.day} 天标题未成功写入（输入框为空）。`);
    }
    const scope = dayScopeFor(titleInput);
    await assertCount(scope, 1, `第 ${day.day} 天行程区域`);
    if (product.operations?.transport === "charter") {
      await clickExact(scope, "包车", `第 ${day.day} 天包车选项`);
    }
      await fillPickupAndDropoff(
        page,
        scope,
        index,
        normalizedDays.length,
        product.operations ?? {
          reusePickupForDropoff: true,
        },
      { disambiguator, product },
    );
    await fillMealCards(scope, day, product.operations?.mealsIncluded === true);
    if (product.operations) {
      await fillHotelCard(page, scope, day, product.operations);
    }
    await ensureServiceTimeRange(scope, day);
    const otherCard = await ensureOtherCard(page, scope, {
      afterFirstCard: index === 0,
    });
    const unlimited = otherCard.getByText("不限", { exact: true });
    if (await unlimited.count()) await unlimited.first().click();
    const description = otherCard.locator('textarea[placeholder="请输入补充说明"]');
    if (!(await description.count())) {
      throw new Error(`第 ${day.day} 天"其他"节点缺少补充说明`);
    }
    await description.first().fill(day.description);
    const descriptionAfterFill = (await description.first().inputValue()).trim();
    if (!descriptionAfterFill) {
      throw new Error(`第 ${day.day} 天"其他"补充说明未成功写入（输入框为空）。`);
    }
  }

  const savedWith = await clickSafeSave(page, ["存为草稿"]);
  // VBK tourdays 页「存为草稿 / 提交审核并下一步」之后 WebContents URL
  // 会直接落到 https://vbooking.ctrip.com/ivbk/vendor/packageManage?...，
  // 跨页面后套餐管理 tab 暂不存在，必须用 URL 落点判定「auto-navigated」，
  // 不再退回到 tab active / unlocked 探测，避免 attempt2 已成功却被误判为
  // 未到达目标、继续点下一步生成 attempt3 噪声。active / unlocked 探测仍
  // 由 saveThenAdvance 保留作为兜底。
  const submitResult = await saveThenAdvance(page, {
    phase: "ItineraryDraft",
    targetTabLabel: "套餐管理",
    saveButtonNames: ["存为草稿"],
    targetTabLabels: ["套餐管理"],
    isTargetUrl: isPackageManageUrl,
    nextButtonLabel: "提交审核并下一步",
    // VBK 会在行程提交后进入「AI审核中，约需1-2min」；真实页面曾在
    // 约 20 秒后才跳到套餐管理，不能沿用通用页面的 15 秒短门限。
    advanceTimeoutMs: 120_000,
    savedWith,
  });
  if (!submitResult?.advanced) {
    throw new Error("ItineraryDraft 未提交通过：未进入下一阶段");
  }
  const spotResult = await ensureItinerarySpotsApi(page, normalizedProduct, productId);
  await delay(3_000);
  return { savedWith, days: normalizedDays.length, spotResult };
}

/**
 * 测试切片占位：source-slicing 锚点，运行时不会被调用（行程阶段实际用 stations 的开关）。
 */
async function chooseRadioValue(_page, _groupId, _value, _description) { return null; }
