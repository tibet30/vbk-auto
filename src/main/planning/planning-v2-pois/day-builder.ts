/**
 * 单日行程展示 / 描述 / 用餐辅助：
 *   - itineraryDisplayUnits：把 draft.poiIds 按 userActivityId 合并"或"展示单元；
 *   - findSplitUserAlternativeGroup：用户备选 POI 必须连续放在同一段；
 *   - joinAlternativeLabels：把相同 userActivityId 的多份候选拼成"X 或 Y"；
 *   - mealDescriptionsForDay / mealSummaryForDay：用餐文案（首日无早，最后一日无晚）；
 *   - buildDailyDescription：把上 / 下午 + 用餐 + 住宿节点拼成每日 description；
 *   - hasBacktrack：跨日城市序列不能形成 A→B→A 折返。
 */

import type { PlanningPoiCandidate } from "../../../shared/contracts-planning.js";

export function itineraryDisplayUnits(
  poiIds: number[],
  pool: Map<number, PlanningPoiCandidate>,
): Array<{ label: string; poiIds: number[] }> {
  const units: Array<{ key: string; label: string; poiIds: number[] }> = [];
  for (const poiId of poiIds) {
    const candidate = pool.get(poiId);
    const name = candidate?.poiName;
    if (!candidate || !name) continue;
    const key = candidate.source === "user" && candidate.userActivityId
      ? `user:${candidate.userActivityId}`
      : `poi:${poiId}`;
    const previous = units[units.length - 1];
    if (previous?.key === key) {
      previous.label = joinAlternativeLabels(previous.label, name);
      previous.poiIds.push(poiId);
    } else {
      units.push({ key, label: name, poiIds: [poiId] });
    }
  }
  return units.map(({ label, poiIds }) => ({ label, poiIds }));
}

export function findSplitUserAlternativeGroup(
  poiIds: number[],
  pool: Map<number, PlanningPoiCandidate>,
): string | undefined {
  const positionsByActivity = new Map<string, Array<{ index: number; name: string }>>();
  for (const [index, poiId] of poiIds.entries()) {
    const candidate = pool.get(poiId);
    if (candidate?.source !== "user" || !candidate.userActivityId) continue;
    const positions = positionsByActivity.get(candidate.userActivityId) ?? [];
    positions.push({ index, name: candidate.poiName || candidate.requestedName });
    positionsByActivity.set(candidate.userActivityId, positions);
  }
  for (const positions of positionsByActivity.values()) {
    if (positions.length < 2) continue;
    const indexes = positions.map((item) => item.index);
    if (Math.max(...indexes) - Math.min(...indexes) + 1 !== positions.length) {
      return positions.map((item) => item.name).join("或");
    }
  }
  return undefined;
}

export function joinAlternativeLabels(existing: string, next: string): string {
  const values = existing.split("或").concat(next).map((item) => item.trim()).filter(Boolean);
  return [...new Set(values)].join("或");
}

export function mealDescriptionsForDay(index: number, totalDays: number): [string, string, string] {
  return [
    index === 0 ? "" : "是否含餐，以酒店房型为准。",
    "午餐自理",
    index === totalDays - 1 ? "" : "晚餐自理",
  ];
}

export function mealSummaryForDay(index: number, totalDays: number): string {
  return mealDescriptionsForDay(index, totalDays)
    .filter(Boolean)
    .map((description) => description.replace(/[。；]+$/u, ""))
    .join("；");
}

export function buildDailyDescription(args: {
  isFirst: boolean;
  isLast: boolean;
  morning: string[];
  afternoon: string[];
  hotel: string;
}): string {
  return [
    !args.isFirst ? "早餐：是否含餐，以酒店房型为准" : "",
    args.morning.length ? `上午游览${args.morning.join("、")}` : "",
    "午餐自理",
    args.afternoon.length ? `下午游览${args.afternoon.join("、")}` : "",
    !args.isLast ? "晚餐自理" : "",
    args.hotel ? `入住${args.hotel}` : "",
  ].filter(Boolean).join("；");
}

export function hasBacktrack(cities: string[]): boolean {
  for (let i = 2; i < cities.length; i += 1) {
    if (cities[i] && cities[i] === cities[i - 2] && cities[i] !== cities[i - 1]) return true;
  }
  return false;
}