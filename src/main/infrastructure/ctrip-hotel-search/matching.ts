import { hotelDiamondFromTier } from "../../../shared/hotel-tiers.js";
import type { HotelStayRequirement } from "../../../shared/hotel-stay-requirement.js";
import type { HotelSearchContext as Context } from "../ctrip-hotel-search-types.js";
import { HotelCandidatesUnavailableError, HotelSearchEmptyResultError } from "../ctrip-hotel-list-parser.js";
import { fetchCtripHotelCandidates } from "./provider.js";

/** A missing per-day permission never authorizes a lower hotel tier. */
export function isHotelDowngradeAllowed(permission: boolean | Map<number, boolean>, day: number): boolean {
  return permission instanceof Map ? permission.get(day) === true : permission === true;
}

export async function fetchHotelCandidatesWithFallback(anchor: Context, dates: { checkin: string; checkout: string }, hotelTier?: string, requirement?: HotelStayRequirement, allowDowngrade = false, fetcher: typeof fetch = fetch) {
  const target = anchor.requirement?.diamond ?? hotelDiamondFromTier(hotelTier);
  const declared = requirement?.ratingAlternatives?.length
    ? requirement.ratingAlternatives.map(item => ({ ratingType: item.ratingType, diamond: item.diamond ?? (item.ratingType === "diamond" ? target : undefined) }))
    : [{ ratingType: requirement?.ratingType, diamond: target }];
  const attempts = declared.flatMap(item => {
    const grades = item.diamond && allowDowngrade
      ? Array.from({ length: item.diamond + 1 }, (_, index) => item.diamond! - index)
      : [item.diamond];
    return grades.map(diamond => ({ ...item, diamond }));
  });
  let failure: unknown;
  for (const attempt of attempts) {
    try {
      const searchTier = hotelTier;
      const rankingTier = attempt.ratingType === "homestay" ? undefined : hotelTier;
      return await fetchCtripHotelCandidates({ ...anchor, requirement: { anchorName: anchor.name, ...anchor.requirement,
        ...(attempt.diamond !== undefined ? { diamond: attempt.diamond } : {}), ...(attempt.ratingType ? { ratingType: attempt.ratingType } : {}) } }, dates, fetcher, searchTier, rankingTier);
    } catch (error) {
      // 仅对已解析的空结果或候选不匹配尝试下一档；网络/登录/解析异常直接上报。
      // 空列表也可能来自验证码，因此不能据此声称当地没有酒店。
      if (!(error instanceof HotelCandidatesUnavailableError) && !(error instanceof HotelSearchEmptyResultError)) throw error;
      failure = error;
    }
  }
  throw failure;
}
