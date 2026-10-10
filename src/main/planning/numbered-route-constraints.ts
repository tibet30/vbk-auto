import type { ProductDetail } from "../../shared/contracts.js";
import { requiresItineraryPoi } from "../../shared/itinerary-activity-kind.js";
import { dayHasTransportArrangement } from "../../shared/itinerary-support-arrangements.js";

/** 连字符编号的完整路线同样是用户约束；核对途经地，不把行政节点变成 POI。 */
export function numberedRouteConstraintError(product: ProductDetail, itinerary: Record<string, unknown>[]): string | undefined {
  const basic = product.product.basicInfo as Record<string, unknown> | undefined;
  const raw = String(basic?.userIdea ?? "");
  const days = Number(basic?.days);
  const rows = completeNumberedRouteRows(raw, days);
  if (!rows) return undefined;
  for (const row of rows) {
    const dayNumber = Number(row[1]);
    if (dayNumber < 1 || dayNumber > days) return undefined;
    const day = itinerary.find(day => Number(day.day) === dayNumber);
    if (!day) continue; // 天数完整性由主合同统一校验。
    const descriptions = (value: unknown, fields: string[]) => (Array.isArray(value) ? value : [])
      .flatMap(item => item && typeof item === "object" ? fields.map(field => item[field]) : []);
    const words = [day.title, day.description, day.hotel, day.hotelDescription, day.meals,
      ...descriptions(day.spots, ["name", "poiName", "description"]),
      ...descriptions(day.activities, ["title", "detail"])]
      .filter((value): value is string => typeof value === "string").join(" ").replace(/\s+/g, "").replace(/(?:县|市)(?=美食)/gu, "");
    const segments = row[2]!.split(/[-—–→]+/u);
    const allowed = segments.map(segment => cleanAnchor(segment));
    const extra = (Array.isArray(day.spots) ? day.spots : []).find(spot => {
      if (!spot || typeof spot !== "object" || !requiresItineraryPoi(spot)) return false;
      const name = compact(String(spot.name ?? ""));
      return name && !allowed.some(anchor => anchor && (anchor === name || anchor.includes(name) || name.endsWith(anchor)));
    });
    if (extra) return `第 ${dayNumber} 天用户已给出完整编号路线，不能新增或替换景点「${extra.name}」；请按原始安排保留接送、住宿、自由活动，不把途经城市扩展成景区。`;
    for (const segment of segments) {
      const name = segment.replace(/[;；。]+$/u, "").trim();
      const transfer = name.match(/^(.*?)(?:接|送)(?:飞机|高铁|火车|站|机|团|$)/u);
      const anchor = (transfer ? transfer[1] : name)
        ?.replace(/^(?:住宿|入住|住|游览|参观|前往|泡)/u, "").replace(/住宿$/u, "").trim();
      if (anchor && !words.includes(anchor.replace(/\s+/g, "").replace(/(?:县|市)(?=美食)/gu, ""))) {
        return `第 ${dayNumber} 天未保留用户编号路线中的「${anchor}」，不能继续录入。`;
      }
      if (transfer && !dayHasTransportArrangement(day)) return `第 ${dayNumber} 天未保留用户要求的接送安排。`;
    }
  }
  return undefined;
}

export function hasCompleteNumberedRoute(raw: string, days: number): boolean {
  return Boolean(completeNumberedRouteRows(raw, days));
}

function completeNumberedRouteRows(raw: string, days: number): RegExpMatchArray[] | undefined {
  const route = raw.replace(/(?:^|[\n\r])\s*(?:住宿与商业配置|住宿配置|商业配置|录入配置)[:：][\s\S]*$/u, "");
  const rows = [...route.matchAll(/^\s*(\d{1,2})\s*[-、:：.]\s*([^\n\r]+)/gm)];
  if (rows.length !== days || new Set(rows.map(row => Number(row[1]))).size !== days
    || rows.some(row => Number(row[1]) < 1 || Number(row[1]) > days)
    || !rows.some(row => /---|→|—/u.test(row[2]!))) return undefined;
  return rows;
}
function cleanAnchor(segment: string): string {
  return compact(segment.replace(/[;；。]+$/u, "").trim().replace(/^(?:住宿|入住|住|游览|参观|前往|泡)/u, "").replace(/住宿$/u, ""));
}
function compact(value: string): string { return value.replace(/\s+/gu, "").replace(/(?:县|市)(?=美食)/gu, ""); }
