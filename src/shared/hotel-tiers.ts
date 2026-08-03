export const HOTEL_TIER_VALUES = [
  "当地5钻酒店/-38",
  "当地4钻酒店/-4",
  "当地3钻酒店/-3",
] as const;

export const DEFAULT_HOTEL_TIER = HOTEL_TIER_VALUES[0];

// 旧版误把 customHotels 中 key=-5 当成 5 钻；实际 -5 是当地2钻酒店。
export const LEGACY_FIVE_DIAMOND_HOTEL_TIER = "当地5钻酒店/-5";

export function hotelDiamondFromTier(value: unknown) {
  if (typeof value !== "string" || !(HOTEL_TIER_VALUES as readonly string[]).includes(value)) return undefined;
  const match = value.match(/当地([345])钻酒店\//);
  return match ? Number(match[1]) : undefined;
}

export function hotelCandidateMatchesTier(candidate: unknown, hotelTier: unknown) {
  if (typeof candidate !== "string") return false;
  const diamond = hotelDiamondFromTier(hotelTier);
  if (!diamond) return false;
  // VBK 酒店资源中 5 星与行程的当地 5 钻按同等级处理。
  const grade = diamond === 5 ? "5(?:钻|星)" : `${diamond}钻`;
  return new RegExp(`(?:^|[，,\\s])${grade}(?:$|[，,】\\s])`).test(candidate);
}
