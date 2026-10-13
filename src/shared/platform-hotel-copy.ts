import { PLATFORM_HOTEL_DESCRIPTION } from "./platform-hotel-rules.js";
type Json = Record<string, any>;
export function cleanPlatformHotelCopy(value: unknown, oldHotels: string[] = []): unknown {
  if (typeof value !== "string" || value === PLATFORM_HOTEL_DESCRIPTION) return value;
  // Generated copy is immutable: generic hotel names must never match inside it.
  const stable = [PLATFORM_HOTEL_DESCRIPTION, "平台自动匹配酒店", "携程平台酒店", "平台酒店"];
  const hotels = [...new Set(oldHotels)].filter(hotel => hotel && /酒店|宾馆|客栈|民宿/.test(hotel)
    && !stable.some(copy => copy.includes(hotel))).sort((a, b) => b.length - a.length);
  const pattern = /(使用携程平台酒店，自动匹配三钻、四钻、五钻酒店|平台自动匹配酒店|携程平台酒店|平台酒店)/u;
  return value.split(pattern).map(part => {
    if (stable.includes(part)) return part;
    let result = part;
    for (const hotel of hotels) result = result.split(hotel).join(PLATFORM_HOTEL_DESCRIPTION);
    return result.split(PLATFORM_HOTEL_DESCRIPTION).map(part => part.replace(/(?:全程|每晚|全部|当地|优先|入住|安排|精选)*[1-5一二三四五]\s*(?:圆钻|钻|星级|星)(?:酒店|民宿|住宿)?/gu, "平台自动匹配酒店")
    .replace(/(?:入住|住宿于|住宿在|安排入住)?(?:当地|特色|精品)?(?:民宿|客栈)(?:住宿)?/gu, "平台自动匹配酒店")
    // Only lodging proximity is obsolete; route distances and preceding POIs remain.
    .replace(/(?:酒店|住宿)(?:距离|距|离)[^，。；;\n\d]*\d+\s*(?:公里|km)(?:以内|内|左右)?/giu, PLATFORM_HOTEL_DESCRIPTION)
    .replace(/住宿距离限制[^，。；;\n]*/gu, PLATFORM_HOTEL_DESCRIPTION)
    .replace(/住宿评级：[^\n]*/gu, "住宿：" + PLATFORM_HOTEL_DESCRIPTION)).join(PLATFORM_HOTEL_DESCRIPTION);
  }).join("");
}
export function normalisePlatformHotelCopy(product: Json, oldHotels: string[]): Json {
  const basic = product.basicInfo;
  if (basic) for (const key of ["subtitle", "operationNotes"]) basic[key] = cleanPlatformHotelCopy(basic[key], oldHotels);
  const presentation = product.presentation;
  if (presentation) {
    for (const key of ["recommendation", "features"]) presentation[key] = cleanPlatformHotelCopy(presentation[key], oldHotels);
    if (Array.isArray(presentation.recommendations)) presentation.recommendations = presentation.recommendations.map((row: Json) => ({ ...row, text: cleanPlatformHotelCopy(row.text, oldHotels) }));
  }
  return product;
}
