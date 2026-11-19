import { usesPlatformHotelRules, validPlatformHotelRules, platformHotelStayGroups, PLATFORM_HOTEL_DESCRIPTION } from "../../../shared/platform-hotel-rules.js";
import type { PreparationGap } from "../../../shared/contracts-preparation.js";
import { needsItineraryHotelCandidates } from "../../../shared/itinerary-hotel.js";
import { productNeedsVehicleResource } from "../../../shared/product-form.js";
import { hasSatisfiedVehicleResource } from "../../../shared/research-task-satisfaction.js";
import { isNonWritableCityAlias } from "../../../shared/region-overrides.js";
import { spotNamedHotelCity, unwritableHotelCityReason } from "../../../shared/hotel-city-evidence.js";
import { hotelStayRequirement } from "../../../shared/hotel-stay-requirement.js";
import { asArray, asObject, textValue } from "./common.js";

export function resourceGaps(product: Record<string, unknown>): PreparationGap[] {
  const gaps: PreparationGap[] = [];
  const basic = asObject(product.basicInfo);
  const operations = asObject(product.operations);
  const nights = Number(basic?.nights);
  const itinerary = asArray(product.itinerary) ?? [];
  if (usesPlatformHotelRules(product)) {
    if (itinerary.some((day: any, index) => needsItineraryHotelCandidates(day, index, nights))) {
      let detail = validPlatformHotelRules(operations?.hotelRules) ? "" : "酒店规则缺失或无效：必须自动匹配三钻、四钻、五钻";
      try { platformHotelStayGroups(product); } catch (error) { detail ||= String(error); }
      if (itinerary.some((day: any, index) => needsItineraryHotelCandidates(day, index, nights)
        && (day.hotel !== PLATFORM_HOTEL_DESCRIPTION || !day.hotelCity || day.hotelCandidates !== undefined || day.hotelRequirement !== undefined)))
        detail ||= "住宿安排未转换为平台酒店规则或缺少实际住宿城市";
      if (detail) gaps.push({ code: "hotel", label: "平台酒店规则", detail, stage: "completion", node: "hotelResolution" });
    }
    gaps.push(...hotelCityGaps(product, itinerary, nights));
  }
  if (productNeedsVehicleResource(product) && !hasSatisfiedVehicleResource(product)) {
    gaps.push({
      code: "vehicle", label: "用车资源组",
      detail: "已配置用车的产品需要在本地准备阶段匹配用车资源组。",
      stage: "completion",
      node: "vehicleResource",
    });
  }

  return gaps;
}

/**
 * 住宿城市必须是平台可写行政短名。景区短名（珠峰）、乡镇名（狮泉河镇）与
 * 区域别名（潮汕）只有进入携程住宿资源阶段查询城市时才暴露，此前没有任何
 * 本地门禁；这里用当天已核验景点的行政归属给出可执行结论，不让错误数据
 * 走到录入阶段才失败。
 */
function hotelCityGaps(product: Record<string, unknown>, itinerary: unknown[], nights: number): PreparationGap[] {
  const gaps: PreparationGap[] = [];
  for (const [index, value] of itinerary.entries()) {
    const day = asObject(value);
    if (!day || !needsItineraryHotelCandidates(day, index, nights)) continue;
    const saved = textValue(day.hotelCity);
    if (!saved) continue;
    const reason = hotelCityProblem(product, day, saved);
    if (!reason) continue;
    gaps.push({
      code: "hotel", label: `住宿城市：第 ${Number(day.day) || index + 1} 天`,
      detail: `${reason}；未按所属县市修正前不能进入携程行程录入。`,
      stage: "completion", node: "hotelResolution",
    });
  }
  return gaps;
}

function hotelCityProblem(product: Record<string, unknown>, day: Record<string, unknown>, saved: string): string {
  if (isNonWritableCityAlias(saved)) return `「${saved}」是区域或景区别名，平台住宿城市只接受行政城市短名`;
  const suffix = unwritableHotelCityReason(saved);
  if (suffix) return suffix;
  const requirement = hotelStayRequirement(product, day);
  const spot = spotNamedHotelCity(product, day, [saved, requirement?.anchorName]);
  if (spot && spot.city !== saved) {
    return `「${saved}」是当天已核验景点「${spot.spotName}」的名称，平台住宿城市应写所属县市「${spot.city}」`;
  }
  return "";
}
