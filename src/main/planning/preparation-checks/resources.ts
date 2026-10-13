import { usesPlatformHotelRules, validPlatformHotelRules, platformHotelStayGroups, PLATFORM_HOTEL_DESCRIPTION } from "../../../shared/platform-hotel-rules.js";
import type { PreparationGap } from "../../../shared/contracts-preparation.js";
import { needsItineraryHotelCandidates } from "../../../shared/itinerary-hotel.js";
import { productNeedsVehicleResource } from "../../../shared/product-form.js";
import { hasSatisfiedVehicleResource } from "../../../shared/research-task-satisfaction.js";
import { HOTEL_RESOURCE_CANDIDATE_COUNT, HOTEL_RESOURCE_MIN_CANDIDATE_COUNT } from "../../../shared/hotel-candidate-counts.js";
import { hotelDiamondFromTier } from "../../../shared/hotel-tiers.js";
import { hotelCandidateMeetsStay, hotelStayRequirement, hotelDiamondForStay, type HotelStayRequirement } from "../../../shared/hotel-stay-requirement.js";
import { asArray, asObject, textValue } from "./common.js";

export function resourceGaps(product: Record<string, unknown>): PreparationGap[] {
  const gaps: PreparationGap[] = [];
  const basic = asObject(product.basicInfo);
  const operations = asObject(product.operations);
  const hotelDiamond = hotelDiamondFromTier(operations?.hotelTier);
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
  for (const [index, day] of itinerary.entries()) {
    if (usesPlatformHotelRules(product)) break;
    const lodgingDay = asObject(day);
    if (!lodgingDay || !needsItineraryHotelCandidates(lodgingDay, index, nights)) continue;
    const candidates = asArray(lodgingDay.hotelCandidates) ?? [];
    const requirement = hotelStayRequirement(product, lodgingDay);
    if (!hasValidItineraryHotelCandidates(candidates, hotelDiamondForStay(typeof operations?.hotelTier === "string" ? operations.hotelTier : undefined, requirement) ?? hotelDiamond)
      || !candidates.every(candidate => hotelCandidateMeetsStay(asObject(candidate) ?? {}, requirement))) {
      gaps.push({
        code: "hotel", label: `酒店候选：第 ${Number(lodgingDay.day) || index + 1} 天`,
        detail: hotelGapDetail(candidates, hotelDiamondForStay(typeof operations?.hotelTier === "string" ? operations.hotelTier : undefined, requirement) ?? hotelDiamond,
          requirement?.cityName || textValue(basic?.meetingCity), operations?.hotelFallbackPolicy, requirement),
        stage: "completion",
        node: "hotelResolution",
      });
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

function hotelGapDetail(candidates: unknown[], diamond: number | undefined, city: string, fallback: unknown, requirement?: HotelStayRequirement): string {
  const required = `要求：${city || "住宿城市"}，${diamond === undefined ? "有效钻级" : `${diamond}钻`}${requirement?.anchorName ? `，住宿地点${requirement.anchorName}` : ""}${requirement?.maxDistanceKm !== undefined ? `，距离≤${requirement.maxDistanceKm}km` : ""}，保存 ${HOTEL_RESOURCE_MIN_CANDIDATE_COUNT}–${HOTEL_RESOURCE_CANDIDATE_COUNT} 个含有效酒店ID、城市、锚点、评分及距离的真实携程酒店候选`;
  const valid = candidates.filter(candidate => hasValidItineraryHotelCandidates([candidate], diamond)
    && hotelCandidateMeetsStay(asObject(candidate) ?? {}, requirement));
  const actual = candidates.map(value => {
    const candidate = asObject(value);
    const missing = ["hotelId", "hotelName", "diamond", "score", "distanceKm", "cityName", "anchorName", "anchorCityId"]
      .filter(key => candidate?.[key] === undefined || candidate?.[key] === null || candidate?.[key] === "");
    const differences = [candidate?.diamond !== diamond ? `实际${candidate?.diamond ?? "缺失"}钻≠要求${diamond ?? "缺失"}钻` : "",
      textValue(candidate?.cityName) !== city && city ? `实际城市${textValue(candidate?.cityName) || "缺失"}≠要求${city}` : "",
      requirement?.maxDistanceKm !== undefined && Number(candidate?.distanceKm) > requirement.maxDistanceKm
        ? `实际距离${candidate?.distanceKm}km＞允许${requirement.maxDistanceKm}km` : "",
      requirement?.ratingType && (candidate?.ratingType ?? "diamond") !== requirement.ratingType
        ? `实际评级类型${candidate?.ratingType ?? "diamond"}≠要求${requirement.ratingType}` : "",
      requirement?.anchorName && !textValue(candidate?.anchorName).includes(requirement.anchorName.replace(/(?:市|县|镇|村)$/u, ""))
        ? `实际锚点${textValue(candidate?.anchorName) || "缺失"}不属于要求住宿地点${requirement.anchorName}` : "",
      missing.length ? `缺少字段${missing.join("、")}` : ""].filter(Boolean);
    return `${textValue(candidate?.hotelName) || "未命名酒店"}：${differences.join("，") || "身份或字段值校验未通过"}`;
  });
  const difference = candidates.length === 0 ? "差异：0＜1，缺少真实酒店候选"
    : `差异：候选数量或身份、城市、评级、评分、距离字段未满足门禁${actual.length ? `（${actual.join("；")}）` : ""}`;
  return `行程录入页使用携程平台酒店；${required}；实际：已保存${candidates.length}个，通过身份/字段/钻级检查${valid.length}个；${difference}；降档规则：${asObject(fallback)?.allowDowngrade === false ? "禁止" : "按已有许可逐级核验"}。`;
}

function hasValidItineraryHotelCandidates(candidates: unknown[], requiredDiamond: number | undefined): boolean {
  if (candidates.length < HOTEL_RESOURCE_MIN_CANDIDATE_COUNT || candidates.length > HOTEL_RESOURCE_CANDIDATE_COUNT || requiredDiamond === undefined) return false;
  return candidates.every((value) => {
    const candidate = asObject(value);
    return Boolean(candidate
      && Number.isInteger(candidate.hotelId) && Number(candidate.hotelId) > 0
      && textValue(candidate.hotelName)
      && typeof candidate.diamond === "number" && candidate.diamond === requiredDiamond
      && typeof candidate.score === "number" && Number.isFinite(candidate.score) && candidate.score >= 0
      && typeof candidate.distanceKm === "number" && Number.isFinite(candidate.distanceKm) && candidate.distanceKm >= 0
      && textValue(candidate.cityName)
      && textValue(candidate.anchorName)
      && Number.isInteger(candidate.anchorCityId) && Number(candidate.anchorCityId) > 0);
  });
}
