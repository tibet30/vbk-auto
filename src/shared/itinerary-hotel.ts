const NO_HOTEL_STAY = /^(?:无|本日无住宿|本日不住宿|当日无住宿|当日不住宿|无住宿安排|无需住宿|(?:本日|当日)?(?:返程|送站|行程结束)[，,、；;\s]*(?:不安排|无需|无)(?:住宿|酒店))(?:[（(].*[）)])?$/;

/**
 * 明确的不住宿文案不能被当作酒店名称或住宿晚。规划器既可能写入精简的
 * “无”，也可能写入面向用户的“本日无住宿”或“当日返程，不安排住宿”。
 * 这些写法以及带括号说明的版本必须保持相同语义。
 */
export function hasItineraryHotelStay(hotel: unknown): boolean {
  const value = typeof hotel === "string" ? hotel.trim() : "";
  return value.length > 0 && !NO_HOTEL_STAY.test(value);
}
