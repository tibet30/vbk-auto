import type { PreparationGap } from "../../../shared/contracts-preparation.js";
import { needsItineraryHotelCandidates } from "../../../shared/itinerary-hotel.js";
import { productNeedsVehicleResource } from "../../../shared/product-form.js";
import { hasSatisfiedVehicleResource } from "../../../shared/research-task-satisfaction.js";
import { HOTEL_RESOURCE_CANDIDATE_COUNT, HOTEL_RESOURCE_MIN_CANDIDATE_COUNT } from "../../../shared/hotel-candidate-counts.js";
import { hotelDiamondFromTier } from "../../../shared/hotel-tiers.js";
import { hotelCandidateMeetsStay, hotelStayRequirement, hotelDiamondForStay } from "../../../shared/hotel-stay-requirement.js";
import { asArray, asObject, textValue } from "./common.js";

export function resourceGaps(product: Record<string, unknown>): PreparationGap[] {
  const gaps: PreparationGap[] = [];
  const basic = asObject(product.basicInfo);
  const operations = asObject(product.operations);
  const hotelDiamond = hotelDiamondFromTier(operations?.hotelTier);
  const nights = Number(basic?.nights);
  const itinerary = asArray(product.itinerary) ?? [];
  for (const [index, day] of itinerary.entries()) {
    const lodgingDay = asObject(day);
    if (!lodgingDay || !needsItineraryHotelCandidates(lodgingDay, index, nights)) continue;
    const candidates = asArray(lodgingDay.hotelCandidates) ?? [];
    const requirement = hotelStayRequirement(product, lodgingDay);
    if (!hasValidItineraryHotelCandidates(candidates, hotelDiamondForStay(typeof operations?.hotelTier === "string" ? operations.hotelTier : undefined, requirement) ?? hotelDiamond)
      || !candidates.every(candidate => hotelCandidateMeetsStay(asObject(candidate) ?? {}, requirement))) {
      gaps.push({
        code: "hotel", label: `酒店候选：第 ${Number(lodgingDay.day) || index + 1} 天`,
        detail: `行程录入页使用携程平台酒店；住宿日必须先持久化 ${HOTEL_RESOURCE_MIN_CANDIDATE_COUNT}–${HOTEL_RESOURCE_CANDIDATE_COUNT} 个含有效ID、城市、锚点、评分、距离且符合已锁定钻级的携程酒店候选，酒店资源阶段再录入真实酒店资源。`,
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
