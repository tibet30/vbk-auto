import { PLATFORM_HOTEL_DESCRIPTION } from "./platform-hotel-rules.js";
type Json = Record<string, any>;
// 钻级区间/列表必须整体折叠成一句，否则「三钻至五钻」「三钻、四钻、五钻」会被逐词
// 替换成「平台自动匹配酒店至平台自动匹配酒店」，产出病句。
const LEVEL = "[1-5一二三四五]";
const GRADE = String.raw`${LEVEL}\s*(?:圆钻|钻|星级|星)`;
const CONNECTOR = String.raw`(?:[、,，\/]|和|与|或(?:者)?|至|到|~|-)`;
// 「三至五钻」只有末项带单位，前项必须靠连接词识别，否则只折叠「五钻」留下「三至…」。
const GRADE_RANGE = String.raw`(?:${GRADE}\s*${CONNECTOR}?\s*|${LEVEL}\s*${CONNECTOR}\s*)+${GRADE}(?:\s*(?:酒店|民宿|住宿))?`;
const GRADE_RANGE_PATTERN = new RegExp(GRADE_RANGE, "gu");
const GRADE_STANDARD_PATTERN = new RegExp(String.raw`按\s*${GRADE_RANGE}\s*(?:的)?(?:标准|规则)`, "gu");
// 「按三至五钻自动匹配」没有「标准/规则」字样，同样折叠成规则表述。
const GRADE_MATCH_PATTERN = new RegExp(String.raw`按\s*${GRADE_RANGE}(?=\s*(?:自动)?匹配)`, "gu");
// 「平台自动匹配三钻至五钻酒店」整体是一个意思，避免折叠后变成「平台自动匹配平台自动匹配酒店」。
const MATCHED_GRADE_PATTERN = new RegExp(String.raw`(?:携程)?(?:平台)?自动匹配(?:的)?\s*${GRADE_RANGE}`, "gu");
const LEGACY = "平台自动匹配酒店";
/** 修复旧版本逐词替换留下的病句；只认旧产物的固定形态，不改其他文案。 */
function repairLegacyHotelCopy(value: string): string {
  return value
    .replace(new RegExp(String.raw`按\s*${LEVEL}\s*${CONNECTOR}\s*${LEGACY}(?:的)?(?:标准|规则)?`, "gu"), "按平台酒店规则")
    .replace(new RegExp(String.raw`${LEVEL}\s*${CONNECTOR}\s*${LEGACY}`, "gu"), LEGACY)
    .replace(new RegExp(String.raw`${LEGACY}(?:\s*${CONNECTOR}\s*${LEGACY})+`, "gu"), LEGACY)
    .replace(new RegExp(String.raw`(?:携程)?(?:平台)?自动匹配(?:的)?\s*${LEGACY}`, "gu"), LEGACY);
}
export function cleanPlatformHotelCopy(value: unknown, oldHotels: string[] = []): unknown {
  if (typeof value !== "string" || value === PLATFORM_HOTEL_DESCRIPTION) return value;
  // Generated copy is immutable: generic hotel names must never match inside it.
  const stable = [PLATFORM_HOTEL_DESCRIPTION, "平台自动匹配酒店", "携程平台酒店", "平台酒店"];
  const hotels = [...new Set(oldHotels)].filter(hotel => hotel && /酒店|宾馆|客栈|民宿/.test(hotel)
    && !stable.some(copy => copy.includes(hotel))).sort((a, b) => b.length - a.length);
  const pattern = /(使用携程平台酒店，自动匹配三钻、四钻、五钻酒店|平台自动匹配酒店|携程平台酒店|平台酒店)/u;
  return repairLegacyHotelCopy(value).split(pattern).map(part => {
    if (stable.includes(part)) return part;
    let result = part;
    for (const hotel of hotels) result = result.split(hotel).join(PLATFORM_HOTEL_DESCRIPTION);
    return result.split(PLATFORM_HOTEL_DESCRIPTION).map(part => part
    .replace(GRADE_STANDARD_PATTERN, "按平台酒店规则")
    .replace(GRADE_MATCH_PATTERN, "按平台酒店规则")
    .replace(MATCHED_GRADE_PATTERN, LEGACY)
    .replace(GRADE_RANGE_PATTERN, "平台自动匹配酒店")
    .replace(/(?:全程|每晚|全部|当地|优先|入住|安排|精选)*[1-5一二三四五]\s*(?:圆钻|钻|星级|星)(?:酒店|民宿|住宿)?/gu, "平台自动匹配酒店")
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
