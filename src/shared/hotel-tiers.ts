export const HOTEL_TIER_VALUES = [
  "当地5钻酒店/-38",
  "当地4钻酒店/-4",
  "当地3钻酒店/-3",
] as const;

export const DEFAULT_HOTEL_TIER = HOTEL_TIER_VALUES[0];

// 旧版误把 customHotels 中 key=-5 当成 5 钻；实际 -5 是当地2钻酒店。
export const LEGACY_FIVE_DIAMOND_HOTEL_TIER = "当地5钻酒店/-5";

/** 真实的「五钻」枚举值（与 HOTEL_TIER_VALUES[0] 等价；显式命名便于调用）。 */
export const FIVE_DIAMOND_HOTEL_TIER = HOTEL_TIER_VALUES[0];

/**
 * 把任何「酒店档次字符串」规整成当前白名单的合法值。
 *  - 已经是白名单之一 → 原样返回；
 *  - 旧的「当地5钻酒店/-5」 → 自动纠正为「当地5钻酒店/-38」；
 *  - 任何其它值（含 2 钻、空串、null）→ 返回 undefined。
 */
export function normaliseHotelTier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if ((HOTEL_TIER_VALUES as readonly string[]).includes(trimmed)) return trimmed;
  if (trimmed === LEGACY_FIVE_DIAMOND_HOTEL_TIER) return FIVE_DIAMOND_HOTEL_TIER;
  return undefined;
}

export function hotelDiamondFromTier(value: unknown) {
  const normalised = normaliseHotelTier(value);
  if (!normalised) return undefined;
  const match = normalised.match(/当地([345])钻酒店\//);
  return match ? Number(match[1]) : undefined;
}

export function hotelCandidateMatchesTier(candidate: unknown, hotelTier: unknown) {
  if (typeof candidate !== "string") return false;
  const diamond = hotelDiamondFromTier(hotelTier);
  if (!diamond) return false;
  // VBK 酒店资源中 5 星与行程的当地 5 钻按同等级处理。
  const grade = diamond === 5 ? "5(?:钻|星)" : `${diamond}钻`;
  return new RegExp(`(?:^|[，,\\s])${grade}(?:$|[，,\u3001】\\s])`).test(candidate);
}