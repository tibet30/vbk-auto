import type { CtripHotelCandidate } from "../../../shared/contracts-types.js";
import type { HotelStayRequirement } from "../../../shared/hotel-stay-requirement.js";

/** Only mutates the caller's cloned day, never the persisted/source itinerary. */
export function applyHotelCandidates(day: Record<string, unknown>, candidates: CtripHotelCandidate[], requirement?: HotelStayRequirement, requestedDiamond?: number): void {
  const selected = candidates[0]!;
  day.hotel = selected.hotelName;
  day.hotelCandidates = candidates;
  day.hotelRequirement = { anchorName: selected.anchorName, cityName: selected.cityName, ...requirement,
    diamond: selected.diamond, ratingType: selected.ratingType ?? "diamond" };
  day.hotelDescription = `优先入住${selected.hotelName}（${selected.diamond === 0 ? "无" : selected.diamond}${selected.ratingType === "homestay" ? "民宿圆钻" : selected.ratingType === "star" ? "星" : "钻"}，距${selected.anchorName}${selected.distanceKm}km）；备选：${candidates.slice(1).map(item => item.hotelName).join("、")}`;
  if (requestedDiamond && selected.diamond < requestedDiamond) day.hotelDescription += `；目标${requestedDiamond}钻在原定住宿地点未取得合格候选，按允许降档规则改为${selected.diamond === 0 ? "无" : selected.diamond}钻，住宿地点保持不变。`;
}
