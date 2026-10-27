/**
 * 「待处理事项里删除 POI」的纯函数部分：
 *   - 按 task 名称或具体 day/spot 定位要删除的行程景点；
 *   - 复用人工删除命令写 removal receipt，保证任务结案、回读和重新出现时
 *     的运营意图都走同一套凭证；
 *   - 删除后仍存在未核验同名景点时拒绝结案，避免组合任务被部分删除误结清。
 */
import type { ManualReviewFieldInput } from "../../shared/contracts.js";
import { hasCompletePoi, requiresItineraryPoi } from "../../shared/itinerary-activity-kind.js";
import { poiResearchTaskNames } from "../../shared/poi-research-tasks.js";
import { samePoiName } from "../../shared/poi-name-key.js";
import { applyItinerarySpotRemove } from "./manual-review-itinerary-field.js";

type Json = Record<string, unknown>;
export interface PoiIssueDeleteTarget {
  taskId?: string;
  dayIndex?: number;
  spotIndex?: number;
}
export interface PoiIssueTaskLike {
  label: string;
  type: string;
}
export interface PoiIssueRemoval {
  product: Json;
  names: string[];
  removed: Array<{ dayIndex: number; spotIndex: number; name: string }>;
}

export function removePoiIssueSpots(
  product: Json,
  task: PoiIssueTaskLike | undefined,
  target: PoiIssueDeleteTarget,
): PoiIssueRemoval {
  const itinerary = Array.isArray(product.itinerary) ? product.itinerary : [];
  const specific = target.dayIndex !== undefined || target.spotIndex !== undefined;
  if (specific) {
    const dayIndex = target.dayIndex;
    const spotIndex = target.spotIndex;
    if (!Number.isInteger(dayIndex) || !Number.isInteger(spotIndex)) throw new Error("删除 POI 的行程位置不合法。");
    const spot = spotAt(itinerary, dayIndex!, spotIndex!);
    const name = text(spot.name) || text(spot.poiName);
    const next = applyItinerarySpotRemove(product, {
      field: "itinerarySpotRemove", dayIndex: dayIndex!, spotIndex: spotIndex!,
    } as Extract<ManualReviewFieldInput, { field: "itinerarySpotRemove" }>);
    return { product: next, names: name ? [name] : [], removed: [{ dayIndex: dayIndex!, spotIndex: spotIndex!, name }] };
  }
  if (!task) throw new Error("缺少要删除的 POI 待处理事项。");
  const names = poiResearchTaskNames(task.label, task.type);
  if (!names.length) throw new Error("该待处理事项不是 POI 核查项，不能删除 POI。");
  const matches = itinerary.flatMap((day, dayIndex) => {
    const spots = isRecord(day) && Array.isArray(day.spots) ? day.spots : [];
    return spots.flatMap((spot, spotIndex) => isRecord(spot) && spotMatchesNames(spot, names)
      ? [{ dayIndex, spotIndex, name: text(spot.name) || text(spot.poiName) }] : []);
  });
  let next = product;
  // 逐日倒序删除，前面的 spotIndex 不会因已经删除后面的条目而漂移。
  for (const item of [...matches].sort((left, right) => right.dayIndex - left.dayIndex || right.spotIndex - left.spotIndex)) {
    next = applyItinerarySpotRemove(next, {
      field: "itinerarySpotRemove", dayIndex: item.dayIndex, spotIndex: item.spotIndex,
    } as Extract<ManualReviewFieldInput, { field: "itinerarySpotRemove" }>);
  }
  return { product: next, names, removed: matches };
}

/** 删除后仍存在同名、要求 POI 且没有有效绑定的景点时，不结案。 */
export function hasUnverifiedPoiSpot(product: Json, names: readonly string[]): boolean {
  const itinerary = Array.isArray(product.itinerary) ? product.itinerary : [];
  return itinerary.some((day) => isRecord(day) && Array.isArray(day.spots)
    && day.spots.some((spot) => isRecord(spot) && requiresItineraryPoi(spot)
      && !hasCompletePoi(spot) && spotMatchesNames(spot, names)));
}

export function spotMatchesNames(spot: Json, names: readonly string[]): boolean {
  const candidates = [text(spot.name), text(spot.poiName)].filter(Boolean);
  return names.some((name) => {
    const parts = [name, ...name.split(/[&＆+＋、]/u).map((part) => part.trim())]
      .filter((part) => part.length >= 2);
    return parts.some((part) => candidates.some((candidate) => samePoiName(candidate, part)
      || (part.length >= 5 && candidate.includes(part))));
  });
}

function spotAt(itinerary: unknown[], dayIndex: number, spotIndex: number): Json {
  const day = itinerary[dayIndex];
  const spots = isRecord(day) && Array.isArray(day.spots) ? day.spots : [];
  const spot = spots[spotIndex];
  if (!isRecord(spot)) throw new Error("目标行程景点不存在，请刷新后重试。");
  return spot;
}
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function isRecord(value: unknown): value is Json {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
