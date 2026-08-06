// @ts-nocheck

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

export async function assertBasicInfoNoRedErrors(page) {
  await delay(800);
  const watched = ["国家景区", "提前预订", "地接社", "管家"];
  const withHelp = page.locator(".ant-form-item-with-help");
  const withControlError = page.locator(".ant-form-item:has(.ant-form-item-control.has-error)");
  const total = (await withHelp.count()) + (await withControlError.count());
  if (!total) return;
  const seen = new Set();
  const labels: string[] = [];
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

