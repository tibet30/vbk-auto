import { normalisePlatformHotelCopy, cleanPlatformHotelCopy } from "./platform-hotel-copy.js";
import { hasItineraryHotelStay, needsItineraryHotelCandidates, normaliseReturnDayLodging, NO_ITINERARY_HOTEL } from "./itinerary-hotel.js";
import { hotelStayRequirement } from "./hotel-stay-requirement.js";
import { toPlatformShortLocationName } from "./location-short-name.js";

type Json = Record<string, any>;
export interface PlatformHotelRules { autoMatch: boolean; grades: number[] }
export const PLATFORM_HOTEL_DESCRIPTION = "使用携程平台酒店，自动匹配三钻、四钻、五钻酒店";
export const PLATFORM_HOTEL_GUIDE = `住宿统一为“${PLATFORM_HOTEL_DESCRIPTION}”。hotelCity 填当晚实际住宿的行政城市短名；住宿默认使用平台资源，无需本地资源准备或酒店选择。只保留住宿城市和晚数，不指定酒店，不保留逐晚钻级、民宿或距离限制，不生成 hotelCandidates、hotelRequirement。无住宿日保持无当日住宿安排。`;
export function defaultPlatformHotelRules(): PlatformHotelRules { return { autoMatch: true, grades: [3, 4, 5] }; }
export function validPlatformHotelRules(value: unknown): value is PlatformHotelRules {
  const rule = value as PlatformHotelRules | undefined;
  return rule?.autoMatch === true && Array.isArray(rule.grades) && rule.grades.length === 3
    && new Set(rule.grades).size === 3 && [3, 4, 5].every(grade => rule.grades.includes(grade));
}
export function usesPlatformHotelRules(product: Json): boolean { return product.operations?.hotelMatchingMode === "rules"; }
export function platformHotelRulesRequired(product: Json): boolean {
  const days = Array.isArray(product.itinerary) ? product.itinerary : [];
  const nights = Number(product.basicInfo?.nights);
  return !days.length ? nights > 0 : days.some((day: Json, index: number) => needsItineraryHotelCandidates(day, index, nights));
}

/** Explicit conversion on new local preparation; readers never migrate saved products. */
export function normalisePlatformHotelProduct(product: Json): Json {
  const next = structuredClone(product);
  const ops = { ...(next.operations ?? {}) };
  if (ops.hotelMatchingMode !== "rules") ops.hotelRules = defaultPlatformHotelRules();
  ops.hotelMatchingMode = "rules";
  delete ops.hotelResource;
  delete ops.hotelFallbackPolicy;
  next.operations = ops;
  const basic = next.basicInfo ?? {};
  const namedHotels = [...[basic.userIdea ?? "", ...(next.itinerary ?? []).map((day: Json) => day.title ?? "")].join("\n").matchAll(/[^，。；、\s→—-]{1,25}(?:酒店|宾馆|客栈|民宿)(?:[（(][^）)]*[）)])?/gu)].map(match => match[0].replace(/^.*(?:入住|住宿于|住宿在|前往|送至|从)/u, ""));
  next.itinerary = (next.itinerary ?? []).map((raw: Json, index: number) => {
    const day = normaliseReturnDayLodging(raw, basic) as Json;
    const stay = needsItineraryHotelCandidates(day, index, Number(basic.nights));
    const requirement = stay ? hotelStayRequirement(next, day) : undefined;
    const city = toPlatformShortLocationName(day.hotelCity || requirement?.cityName || day.hotelRequirement?.cityName
      || day.hotelCandidates?.[0]?.cityName || basic.meetingCity || basic.destinationCity);
    const result: Json = { ...day, hotel: stay ? PLATFORM_HOTEL_DESCRIPTION : NO_ITINERARY_HOTEL,
      hotelDescription: stay ? PLATFORM_HOTEL_DESCRIPTION : NO_ITINERARY_HOTEL };
    delete result.hotelRequirement; delete result.hotelCandidates;
    if (stay) result.hotelCity = city; else delete result.hotelCity;
    const hotelNames = [raw.hotel, ...namedHotels, ...(raw.hotelCandidates ?? []).map((candidate: Json) => candidate.hotelName)];
    result.title = cleanPlatformHotelCopy(result.title, hotelNames);
    if (typeof result.title === "string") result.title = result.title.split(PLATFORM_HOTEL_DESCRIPTION).join("平台酒店");
    const routeCopy = (value: unknown) => {
      const cleaned = cleanPlatformHotelCopy(value, hotelNames);
      return typeof cleaned === "string" ? cleaned.split(PLATFORM_HOTEL_DESCRIPTION).join("平台酒店") : cleaned;
    };
    result.description = routeCopy(result.description);
    if (Array.isArray(result.activities)) result.activities = result.activities.filter((activity: Json) => stay || activity.type !== "hotel").map((activity: Json) =>
      activity.type === "hotel" ? { ...activity, title: "入住平台酒店", detail: PLATFORM_HOTEL_DESCRIPTION }
        : { ...activity, title: routeCopy(activity.title), detail: routeCopy(activity.detail) });
    return result;
  });
  return normalisePlatformHotelCopy(next, (product.itinerary ?? []).flatMap((day: Json) => [day.hotel, ...(day.hotelCandidates ?? []).map((candidate: Json) => candidate.hotelName)]));
}
export function platformHotelStayGroups(product: Json) {
  const groups: Array<{ cityName: string; nights: number; dayNumbers: number[]; hotelIds: number[] }> = [];
  for (const day of product.itinerary ?? []) {
    if (!hasItineraryHotelStay(day.hotel)) continue;
    const cityName = toPlatformShortLocationName(day.hotelCity);
    if (!cityName) throw new Error(`第 ${day.day} 天缺少住宿城市`);
    const last = groups.at(-1);
    if (last?.cityName === cityName && last.dayNumbers.at(-1)! + 1 === Number(day.day)) {
      last.nights++; last.dayNumbers.push(Number(day.day));
    } else groups.push({ cityName, nights: 1, dayNumbers: [Number(day.day)], hotelIds: [] });
  }
  return groups;
}
