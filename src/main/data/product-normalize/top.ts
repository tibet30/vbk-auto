/**
 * product-normalize/top 子模块：normaliseProductDraft 入口。
 *
 * 会深克隆入参再修改，避免污染上游数据。归一化后无法识别的字段会被静默剔除；
 * 调用方拿到的是「尽可能合法但不一定完整」的对象——仍需在下游做必填校验。
 *
 * @param product 原始产品对象（任意来源：AI 输出、数据库读取、import）
 * @param options.safeRelease 传 true 时把 release 强制为 draft-only（仅 AI/自动写入路径需要）
 */

import { defaultCommercialInventory } from "../commercial-defaults.js";
import { normaliseHotelTier } from "../../../shared/hotel-tiers.js";
import { normaliseTrafficLineConfig } from "../../../shared/contracts-traffic-line.js";
import { normaliseCommercialInventory, normaliseCommercialPricing, normaliseCommercialRelease } from "./commercial.js";
import { normaliseItinerary } from "./itinerary.js";
import { normalisePresentation } from "./presentation.js";
import { positiveIntegerValue, positiveNumberValue, textValue } from "./helpers.js";
import { normaliseReturnDayLodging } from "../../../shared/itinerary-hotel.js";
import type { NormaliseOptions } from "./types.js";

/**
 * 产品草稿顶层归一化入口。
 *
 * 会深克隆入参再修改，避免污染上游数据。归一化后无法识别的字段会被静默剔除；
 * 调用方拿到的是「尽可能合法但不一定完整」的对象——仍需在下游做必填校验。
 *
 * @param product 原始产品对象（任意来源：AI 输出、数据库读取、import）
 * @param options.safeRelease 传 true 时把 release 强制为 draft-only（仅 AI/自动写入路径需要）
 */
export function normaliseProductDraft(product: Record<string, unknown>, options?: NormaliseOptions) {
  const result = structuredClone(product);
  const presentation = normalisePresentation(result.presentation);
  const itinerary = normaliseItinerary(result.itinerary);
  if (presentation) result.presentation = presentation;
  if (itinerary) result.itinerary = itinerary.map(day => normaliseReturnDayLodging(day,
    result.basicInfo && typeof result.basicInfo === "object" ? result.basicInfo as Record<string, unknown> : {}));
  if (result.operations && typeof result.operations === "object" && !Array.isArray(result.operations)) {
    const operations = { ...(result.operations as Record<string, unknown>) };
    if (!(["charter", "shared", "none"] as unknown[]).includes(operations.transport)) delete operations.transport;
    if (!textValue(operations.pickupCity)) delete operations.pickupCity;
    if (typeof operations.reusePickupForDropoff !== "boolean") delete operations.reusePickupForDropoff;
    if (operations.hotelSource !== "nonPlatform") delete operations.hotelSource;
    const fallback = operations.hotelFallbackPolicy as Record<string, unknown> | undefined;
    operations.hotelFallbackPolicy = { allowDowngrade: fallback?.allowDowngrade !== false };
    // 酒店档次：使用统一白名单；旧 /-5 自动被 normaliseHotelTier 纠正为 /-38。
    const normalisedTier = normaliseHotelTier(operations.hotelTier);
    if (normalisedTier) operations.hotelTier = normalisedTier;
    else delete operations.hotelTier;
    if (typeof operations.mealsIncluded !== "boolean") delete operations.mealsIncluded;
    const trafficLine = normaliseTrafficLineConfig(operations.trafficLine);
    if (trafficLine) operations.trafficLine = trafficLine;
    else delete operations.trafficLine;
    if (!operations.vehicleResource || typeof operations.vehicleResource !== "object" || Array.isArray(operations.vehicleResource)) {
      operations.vehicleResource = {};
    } else {
      const vehicle = operations.vehicleResource as Record<string, unknown>;
      const days = result.basicInfo && typeof result.basicInfo === "object" && !Array.isArray(result.basicInfo)
        ? positiveIntegerValue((result.basicInfo as Record<string, unknown>).days) || 1
        : 1;
      const requestedTotalCost = positiveNumberValue(vehicle.requestedTotalCost)
        || (positiveNumberValue(vehicle.requestedDailyCost)
          ? positiveNumberValue(vehicle.requestedDailyCost)! * days
          : undefined);
      operations.vehicleResource = {
        ...(requestedTotalCost ? { requestedTotalCost } : {}),
        ...((vehicle.requestedTotalCostCleared === true || vehicle.requestedDailyCostCleared === true)
          ? { requestedTotalCostCleared: true }
          : {}),
        ...(positiveIntegerValue(vehicle.resourceGroupId) ? { resourceGroupId: positiveIntegerValue(vehicle.resourceGroupId) } : {}),
        ...(textValue(vehicle.resourceGroupName) ? { resourceGroupName: textValue(vehicle.resourceGroupName) } : {}),
        ...(positiveIntegerValue(vehicle.serviceHoursPerDay) ? { serviceHoursPerDay: positiveIntegerValue(vehicle.serviceHoursPerDay) } : {}),
        ...(positiveIntegerValue(vehicle.serviceKilometersPerDay) ? { serviceKilometersPerDay: positiveIntegerValue(vehicle.serviceKilometersPerDay) } : {}),
      };
    }
    if (Object.keys(operations).length) result.operations = operations; else delete result.operations;
  }
  if (result.commercial && typeof result.commercial === "object" && !Array.isArray(result.commercial)) {
    const commercial = { ...(result.commercial as Record<string, unknown>) };
    if (!textValue(commercial.packageName)) delete commercial.packageName;
    if (!commercial.terms || typeof commercial.terms !== "object" || Array.isArray(commercial.terms)) delete commercial.terms;
    const pricing = normaliseCommercialPricing(commercial.pricing);
    if (pricing) commercial.pricing = pricing; else delete commercial.pricing;
    const inventory = normaliseCommercialInventory(commercial.inventory);
    commercial.inventory = inventory ?? defaultCommercialInventory();
    const release = normaliseCommercialRelease(commercial.release, { safeRelease: options?.safeRelease });
    if (release) commercial.release = release; else delete commercial.release;
    if (Object.keys(commercial).length) result.commercial = commercial; else delete result.commercial;
  }
  return result;
}