const NO_HOTEL_STAY = /^(?:无|—|-|(?:本日|当日|当天)?(?:无住宿|不住宿)|无(?:本日|当日|当天)?住宿安排|无需住宿|(?:本日|当日|当天)?不安排(?:过夜)?(?:住宿|酒店)?|(?:本日|当日|当天)?(?:返程日?|送站日?|送机日?|行程结束)[，,、；;\s]*(?:不安排|不|无需|无)(?:过夜)?(?:住宿|酒店))(?:[。.!！])?(?:[（(].*[）)])?$/;

/**
 * 明确的不住宿文案不能被当作酒店名称或住宿晚。规划器既可能写入精简的
 * “无”，也可能写入面向用户的“本日无住宿”或“当日返程，不安排住宿”。
 * 这些写法以及带括号说明的版本必须保持相同语义。
 */
export function hasItineraryHotelStay(hotel: unknown): boolean {
  const value = typeof hotel === "string" ? hotel.trim() : "";
  return value.length > 0 && !NO_HOTEL_STAY.test(value);
}

/** D天D-1晚的最后送站日，“敬请自理”是占位文案，不能多生成一晚酒店。
 * 有明确酒店、住宿锚点或候选的末日保持原值；自理住宿日也不能被删掉。
 */
export function normaliseReturnDayLodging<T extends Record<string, unknown>>(day: T, basic: Record<string, unknown>): T {
  const days = Number(basic.days), nights = Number(basic.nights);
  const requirement = day.hotelRequirement as Record<string, unknown> | undefined;
  const route = `${day.title ?? ""} ${day.description ?? ""}`;
  if (!Number.isInteger(days) || days < 1 || Number(day.day) !== days || nights !== days - 1
    || !/^(?:敬请)?自理$/u.test(String(day.hotel ?? "").trim())
    || !/送站|送机|送飞机|送高铁|返程|送团|行程结束/u.test(route)
    || requirement?.anchorName || Array.isArray(day.hotelCandidates) && day.hotelCandidates.length) return day;
  return { ...day, hotel: "无当日住宿安排", hotelDescription: "无当日住宿安排" };
}

/** 行程描述住宿始终使用携程平台酒店。VBK 20013127：套餐「是否含酒店」必须为否。 */
export const ITINERARY_CTRIP_PLATFORM_HOTEL = {
  useSegmentConfig: true,
  ishand: true,
  packageIsHotelResource: "F",
} as const;
