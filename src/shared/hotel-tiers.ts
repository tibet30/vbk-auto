/**
 * 酒店档次白名单与归一化工具。
 *
 * 整个产品草稿、VBK 下拉匹配、酒店资源候选项筛选都引用本模块提供的
 * 合法档次字符串。旧版误把 `当地5钻酒店/-5` 当成 5 钻，实际该 key 对应
 * 2 钻——本模块负责在数据进入/迁出时自动纠正到 `-38`，并拒绝任何其它
 * 非白名单值。
 *
 * 主要导出：
 *  - HOTEL_TIER_VALUES / DEFAULT_HOTEL_TIER / FIVE_DIAMOND_HOTEL_TIER：合法档次枚举
 *  - LEGACY_FIVE_DIAMOND_HOTEL_TIER：旧的 "-5" 字符串，仅用于迁移期识别
 *  - normaliseHotelTier：把任意输入规整成白名单值
 *  - hotelDiamondFromTier：从档次字符串中提取"钻"数字
 *  - hotelCandidateMatchesTier：判断一个酒店资源字符串是否匹配给定档次
 */

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