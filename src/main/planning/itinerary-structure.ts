import { dayHasUserOtherActivity } from "../../shared/itinerary-content.js";
import { validateModuleValue } from "./schemas.js";

type Json = Record<string, unknown>;

/**
 * Checks a persisted itinerary can be handed to POI resolution. It deliberately
 * does not require POI IDs: that is the resolver's next responsibility.
 */
export function itineraryStructureError(product: Record<string, unknown>): string | undefined {
  const basic = record(product.basicInfo);
  const expectedDays = Number(basic?.days);
  if (!Number.isInteger(expectedDays) || expectedDays < 1) return "basicInfo.days 必须是正整数。";
  const itinerary = product.itinerary;
  if (!Array.isArray(itinerary)) return "行程必须是逐日列表。";
  if (itinerary.length !== expectedDays) return `行程天数 ${itinerary.length}，应为 ${expectedDays}。`;

  for (const [index, value] of itinerary.entries()) {
    const day = record(value);
    const label = `第 ${index + 1} 天`;
    if (!day) return `${label}不是对象。`;
    if (day.day !== index + 1) return `${label}的 day 必须从 1 起连续且唯一。`;
    if (!text(day.title)) return `${label}缺少 title。`;
    if (!text(day.description)) return `${label}缺少 description。`;
    if (!text(day.meals)) return `${label}缺少 meals。`;
    const spots = day.spots;
    if (!Array.isArray(spots) || spots.length === 0) {
      if (dayHasUserOtherActivity(day)) continue;
      return `${label}缺少 spots 或合法服务活动。`;
    }
    const schema = validateModuleValue("itinerary", [itineraryInputProjection(day)]);
    if (!schema.ok) return `${label}结构无效：${schema.reason}`;
    // POI 未绑定是下一节点的工作；本关只验证其结构能够交给解析器。
  }
  return undefined;
}

function itineraryInputProjection(day: Json): Json {
  return {
    day: day.day, title: day.title, description: day.description, hotel: day.hotel, meals: day.meals,
    ...(Array.isArray(day.mealDescriptions) ? { mealDescriptions: day.mealDescriptions } : {}),
    spots: Array.isArray(day.spots) ? day.spots.map((spot) => {
      const item = record(spot);
      if (!item) return spot;
      return {
        name: item.name, ...(item.kind !== undefined ? { kind: item.kind } : {}),
        ...(item.description !== undefined ? { description: item.description } : {}),
        ...(item.poiName !== undefined ? { poiName: item.poiName } : {}),
        ...(item.poiId !== undefined ? { poiId: item.poiId } : {}),
        ...(item.timeOfDay !== undefined ? { timeOfDay: item.timeOfDay } : {}),
        ...(item.relation !== undefined ? { relation: item.relation } : {}),
      };
    }) : day.spots,
  };
}

function record(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
}

function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
