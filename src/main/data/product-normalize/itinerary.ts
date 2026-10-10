/**
 * product-normalize/itinerary 子模块：
 *   - normaliseMeals：餐食归一化（string 或 { breakfast/lunch/dinner } → summary + descriptions）；
 *   - normaliseItinerary：顶层行程按天归一化入口；
 *   - normaliseHotelCandidates：酒店候选归一化（接受数组或 { item: [...] } 包裹）。
 *
 * 关键约束：
 *   - 行程天级按 day index 默认递增；
 *   - 接团/接站/送站/送机/早餐/午餐/晚餐/入住/酒店 等关键字不算景点；
 *   - hotelCandidates 数量必须在 [HOTEL_RESOURCE_MIN_CANDIDATE_COUNT, HOTEL_RESOURCE_CANDIDATE_COUNT]
 *     区间内，否则丢弃（保留携程唯一返回场景的弹性）。
 */

import { HOTEL_RESOURCE_CANDIDATE_COUNT, HOTEL_RESOURCE_MIN_CANDIDATE_COUNT } from "../../../shared/hotel-candidate-counts.js";
import { normaliseActivity } from "../product-normalize-activity.js";
import { normaliseReturnDayLodging } from "../../../shared/itinerary-hotel.js";
import { normaliseItinerarySupport } from "../../../shared/itinerary-support-arrangements.js";
import { normaliseItinerarySpotKind } from "../../../shared/itinerary-activity-kind.js";
import { normalisePoiId, textValue } from "./helpers.js";

/**
 * 餐食归一化：接受 string 或 { breakfast/lunch/dinner } 对象，
 * 统一输出 summary（中文拼接）+ 可选 descriptions（三餐逐条）。
 */
function normaliseMeals(value: unknown) {
  if (typeof value === "string") return { summary: value, descriptions: undefined };
  if (!value || typeof value !== "object" || Array.isArray(value)) return { summary: "餐食以实际确认单为准", descriptions: undefined };
  const record = value as Record<string, unknown>;
  const entries = [
    ["早餐", textValue(record.breakfast)],
    ["午餐", textValue(record.lunch)],
    ["晚餐", textValue(record.dinner)],
  ].map(([label, detail]) => `${label}${detail || "待确认"}`);
  return { summary: entries.join("；"), descriptions: entries };
}

/**
 * 归一化产品行程（按天列表）。
 *  - 接受 activities 数组 / spots 数组 / 老的散落字段；
 *  - 一天的活动会被合并成 description；spots 过滤掉接团/送站等非景点词；
 *  - 餐食会被重写成 `早餐…；午餐…；晚餐…` summary 形式；
 *  - 返回 undefined 表示该结构不可用。
 */
export function normaliseItinerary(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const days = value.flatMap((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const rawActivities = Array.isArray(record.activities)
      ? record.activities.filter((activity): activity is Record<string, unknown> => Boolean(activity) && typeof activity === "object" && !Array.isArray(activity))
      : [];
    const activities = rawActivities.map(normaliseActivity)
      .filter((activity): activity is NonNullable<ReturnType<typeof normaliseActivity>> => Boolean(activity));
    const spots = Array.isArray(record.spots)
      ? record.spots.map((spot) => {
        if (typeof spot === "string") return normaliseItinerarySpotKind({ name: spot.trim(), poiName: null, poiId: null });
        if (!spot || typeof spot !== "object") return null;
        const raw = spot as Record<string, unknown>;
        const timeOfDay = raw.timeOfDay === "morning" || raw.timeOfDay === "afternoon"
          ? raw.timeOfDay
          : undefined;
        const relation = raw.relation === "or" ? "or" : raw.relation === "and" ? "and" : undefined;
        return normaliseItinerarySpotKind({
          name: textValue(raw.name) || textValue(raw.poiName),
          poiName: textValue(raw.poiName) || null,
          poiId: normalisePoiId(raw.poiId),
          ...(textValue(raw.description) ? { description: textValue(raw.description) } : {}),
          ...Object.fromEntries(["province", "city", "district"].flatMap(key => textValue(raw[key]) ? [[key, textValue(raw[key])]] : [])),
          ...(timeOfDay ? { timeOfDay } : {}),
          ...(relation ? { relation } : {}),
          ...(raw.kind === "attraction" || raw.kind === "free" || raw.kind === "other" ? { kind: raw.kind } : {}),
        });
      }).filter((spot) => Boolean(spot?.name))
      : rawActivities.map((activity) => textValue(activity.title) || textValue(activity.name)).filter((name) => name && !/接站|接机|送站|送机|早餐|午餐|晚餐|入住|酒店/.test(name));
    const activityDescription = activities
      .map((activity) => [activity.time, activity.title, activity.detail].filter(Boolean).join(" "))
      .filter(Boolean)
      .join("；");
    const meals = normaliseMeals(record.meals);
    const title = textValue(record.title) || `第 ${index + 1} 天行程`;
    const description = textValue(record.description) || [textValue(record.summary), activityDescription].filter(Boolean).join("。") || title;
    const hotel = textValue(record.hotel) || textValue(record.stay);
    const hotelCandidates = normaliseHotelCandidates(record.hotelCandidates);
    return [normaliseItinerarySupport({
      day: Number.isInteger(record.day) && Number(record.day) > 0 ? Number(record.day) : index + 1,
      title,
      spots,
      description,
      hotel,
      ...(record.hotelRequirement && typeof record.hotelRequirement === "object" && !Array.isArray(record.hotelRequirement) ? { hotelRequirement: structuredClone(record.hotelRequirement) } : {}),
      ...(hotelCandidates.length ? { hotelCandidates } : {}),
      meals: meals.summary,
      ...(meals.descriptions ? { mealDescriptions: meals.descriptions } : {}),
      ...(textValue(record.hotelDescription) || hotel ? { hotelDescription: textValue(record.hotelDescription) || hotel } : {}),
      ...(activities.length ? { activities } : {}),
    })];
  });
  return days.length ? days : undefined;
}

function normaliseHotelCandidates(value: unknown) {
  // 老版 Agent 快照曾以 { item: [...] } 包装候选；接纳该确定的导入形态，
  // 其余对象仍按无候选处理，避免不受控的外部字段进入产品草稿。
  const rows = Array.isArray(value)
    ? value
    : value && typeof value === "object" && !Array.isArray(value) && Array.isArray((value as Record<string, unknown>).item)
      ? (value as Record<string, unknown>).item as unknown[]
      : [];
  if (!rows.length) return [];
  const seen = new Set<number>();
  const candidates = rows.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    const hotelId = normalisePoiId(row.hotelId); const hotelName = textValue(row.hotelName);
    const diamond = row.diamond == null ? NaN : Number(row.diamond); const score = Number(row.score); const distanceKm = Number(row.distanceKm);
    const cityName = textValue(row.cityName); const anchorName = textValue(row.anchorName); const anchorCityId = normalisePoiId(row.anchorCityId);
    if (!hotelId || !hotelName || !Number.isInteger(diamond) || diamond < 0 || diamond > 5 || !Number.isFinite(score) || score < 0
      || !Number.isFinite(distanceKm) || distanceKm < 0 || !cityName || !anchorName || !anchorCityId || seen.has(hotelId)) return [];
    seen.add(hotelId);
    return [{ hotelId, hotelName, diamond, score, distanceKm, cityName, anchorName, anchorCityId,
      ...(["diamond", "star", "homestay"].includes(String(row.ratingType)) ? { ratingType: row.ratingType } : {}),
      ...(textValue(row.address) ? { address: textValue(row.address) } : {}) }];
  });
  // 候选最多五家；携程只返回一家时也保留，行程录入阶段采用其中最多前三家。
  return candidates.length >= HOTEL_RESOURCE_MIN_CANDIDATE_COUNT && candidates.length <= HOTEL_RESOURCE_CANDIDATE_COUNT ? candidates : [];
}