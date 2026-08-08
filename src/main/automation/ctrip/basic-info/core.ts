// @ts-nocheck
/**
 * 「基本信息」面板的统一入口与终态校验：
 *   - fillBasicInfo：按 product.basicInfo 完整填「基本信息」面板（副标题、供应商名/编号、操作
 *     说明、出发/目的地、产品线、国家景区、提前预订、地接社、管家联系人等）；
 *   - assertBasicInfoNoRedErrors：保存后扫 .ant-form-item-with-help / .has-error，限定
 *     只关注「国家景区 / 提前预订 / 地接社 / 管家」几类，给出本地化错误。
 * 顶部带 `// @ts-nocheck`，page 是动态传入。
 */

import { delay, assertCount, fillById } from "../utils.js";
import { resolveAdvanceBooking } from "../../schema/schema-functions.js";
import {
  fillCitySelect,
  fillProductLine,
} from "./location.js";
import {
  fillScenicAreaProvince,
  fillScenicAreaSpots,
} from "./scenic.js";
import {
  fillServicePhone,
  fillAdvanceBooking,
  fillLocalTravelAgency,
  fillButlerContact,
} from "./sections.js";

/**
 * 写入「基本信息」面板完整字段：
 *   - 客服电话（来自 extra.servicePhone）；
 *   - 天数 / 晚数 / 副标题 / 供应商名 / 编号 / 操作说明；
 *   - 出发地 + 目的地 + 产品线；
 *   - 国家景区（省份必填，景点仅当 extra.keySpots 非空时填）；
 *   - 提前预订（按 resolveAdvanceBooking 解析）；
 *   - 地接社 + 管家联系人（但仅在外部传入时填）。
 */
export async function fillBasicInfo(page, product, butlerSelection, extra = {}) {
  const info = product.basicInfo;
  await page.getByText("基本信息", { exact: true }).waitFor();
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

  const preferredCountry = info.province && info.province.trim() ? "中国" : undefined;
  const cityContext = { disambiguator: extra?.disambiguator, product };
  await fillCitySelect(page, "baseInfo.masterDepartureCityId", info.meetingCity, preferredCountry, cityContext);
  await fillCitySelect(page, "baseInfo.destinationCityID", info.destinationCity, preferredCountry, cityContext);
  await fillProductLine(page, info.destinationCity, info.province);

  if (info.province) await fillScenicAreaProvince(page, info.province, cityContext);
  const scenicSpotLogs = Array.isArray(extra?.scenicSpotLogs) ? extra.scenicSpotLogs : [];
  if (info.province && Array.isArray(extra?.keySpots) && extra.keySpots.length) {
    await fillScenicAreaSpots(page, info.province, extra.keySpots, scenicSpotLogs, cityContext);
  }
  const advance = resolveAdvanceBooking(product);
  if (advance) await fillAdvanceBooking(page, advance);
  await fillLocalTravelAgency(page);
  if (butlerSelection) await fillButlerContact(page, butlerSelection);
}

/**
 * 校验「基本信息」面板保存后没有红色错误提示：
 *   - 等 800ms 让 antd 完成校验动画；
 *   - 只关注「国家景区 / 提前预订 / 地接社 / 管家」4 个高风险区域，避免被无关注入噪音导致 false positive；
 *   - 任一区域内有红色校验项则抛错，错误信息列出区域名供 UI 直显。
 */
export async function assertBasicInfoNoRedErrors(page) {
  await delay(800);
  const watched = ["国家景区", "提前预订", "地接社", "管家"];
  const withHelp = page.locator(".ant-form-item-with-help");
  const withControlError = page.locator(".ant-form-item:has(.ant-form-item-control.has-error)");
  const total = (await withHelp.count()) + (await withControlError.count());
  if (!total) return;
  const seen = new Set();
  const labels: string[] = [];
  /**
   * 内联 helper：把 withHelp / withControlError 形式的 locator 集合转为「监视频次的 label 列表」，
   * 使用 seen 去重避免同一关键词在 help 与 control 列表里被重复报。
   */
  async function consider(locator: any) {
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