import { usesPlatformHotelRules, validPlatformHotelRules, platformHotelStayGroups, PLATFORM_HOTEL_DESCRIPTION } from "../../../shared/platform-hotel-rules.js";
import type { PreparationGap } from "../../../shared/contracts-preparation.js";
import { needsItineraryHotelCandidates } from "../../../shared/itinerary-hotel.js";
import { productNeedsVehicleResource } from "../../../shared/product-form.js";
import { hasSatisfiedVehicleResource } from "../../../shared/research-task-satisfaction.js";
import { asArray, asObject } from "./common.js";

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
