import type { ManualReviewFieldInput } from "../../shared/contracts.js";
import { normaliseItinerarySpotKind, requiresItineraryPoi } from "../../shared/itinerary-activity-kind.js";
import { alternativeGroupKey, appendTrustedOperatorItineraryRemoval } from "../../shared/trusted-operator-itinerary-removals.js";

type Json = Record<string, unknown>;
function objectValue(value: unknown): Json { return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {}; }

export function applyItinerarySpotPoi(product: Json, input: Extract<ManualReviewFieldInput, { field: "itinerarySpotPoi" }>): Json {
  if (!Number.isInteger(input.dayIndex) || input.dayIndex < 0) throw new Error("行程天数索引不合法。");
  if (!Number.isInteger(input.spotIndex) || input.spotIndex < 0) throw new Error("景点索引不合法。");
  const poiName = input.poiName.trim();
  if (!poiName) throw new Error("POI 名称不能为空。");
  if (!Number.isInteger(input.poiId) || input.poiId <= 0) throw new Error("POI ID 必须是正整数。");
  const next = structuredClone(product) as Json;
  if (!Array.isArray(next.itinerary)) throw new Error("当前产品没有可写入的每日行程。");
  const day = next.itinerary[input.dayIndex];
  if (!day || typeof day !== "object" || Array.isArray(day)) throw new Error("目标行程天数不存在。");
  const dayRecord = day as Json;
  if (!Array.isArray(dayRecord.spots)) throw new Error("目标行程没有可写入的景点列表。");
  const spot = dayRecord.spots[input.spotIndex];
  if (!spot || typeof spot !== "object" || Array.isArray(spot)) throw new Error("目标景点不存在。");
  if (!requiresItineraryPoi(spot as Json)) throw new Error("自由活动或其他活动无需配置 POI；请先切换为景点。");
  dayRecord.spots[input.spotIndex] = { ...(spot as Json), poiName, poiId: input.poiId,
    province: locationText(input.province), city: locationText(input.city), district: locationText(input.district) };
  return next;
}

export function applyItinerarySpotKind(product: Json, input: Extract<ManualReviewFieldInput, { field: "itinerarySpotKind" }>): Json {
  if (!['attraction', 'free', 'other'].includes(input.kind)) throw new Error("行程类型必须是景点、自由活动或其他。");
  if (!Number.isInteger(input.dayIndex) || input.dayIndex < 0 || !Number.isInteger(input.spotIndex) || input.spotIndex < 0) throw new Error("行程条目索引不合法。");
  const next = structuredClone(product) as Json; const day = Array.isArray(next.itinerary) ? next.itinerary[input.dayIndex] : undefined;
  if (!day || typeof day !== "object" || Array.isArray(day) || !Array.isArray((day as Json).spots)) throw new Error("目标行程条目不存在。");
  const spots = (day as Json).spots as unknown[]; const spot = spots[input.spotIndex];
  if (!spot || typeof spot !== "object" || Array.isArray(spot)) throw new Error("目标行程条目不存在。");
  const updated: Json = { ...(spot as Json), kind: input.kind, ...(input.description === undefined ? {} : { description: input.description.trim() }) };
  if (input.kind !== 'attraction') { delete updated.images; delete updated.poiData; delete updated.poiType; delete updated.ticketType; }
  else { updated.poiId = null; updated.poiName = null; delete updated.images; delete updated.poiData; delete updated.poiType; delete updated.ticketType; }
  spots[input.spotIndex] = normaliseItinerarySpotKind(updated);
  return next;
}

export function applyItinerarySpotRemove(product: Json, input: Extract<ManualReviewFieldInput, { field: "itinerarySpotRemove" }>): Json {
  if (!Number.isInteger(input.dayIndex) || input.dayIndex < 0) throw new Error("行程天数索引不合法。");
  if (!Number.isInteger(input.spotIndex) || input.spotIndex < 0) throw new Error("景点索引不合法。");
  const next = structuredClone(product) as Json;
  if (!Array.isArray(next.itinerary)) throw new Error("当前产品没有可删除的每日行程。");
  const day = next.itinerary[input.dayIndex];
  if (!day || typeof day !== "object" || Array.isArray(day)) throw new Error("目标行程天数不存在。");
  const dayRecord = day as Json;
  if (!Array.isArray(dayRecord.spots)) throw new Error("目标行程没有可删除的景点列表。");
  const spot = dayRecord.spots[input.spotIndex];
  if (!spot || typeof spot !== "object" || Array.isArray(spot)) throw new Error("目标景点不存在。");
  const spotName = typeof (spot as Json).name === "string" ? String((spot as Json).name).trim() : "";
  const allSpots = dayRecord.spots as unknown[];
  const alternatives = alternativeGroupIndexes(allSpots, input.spotIndex);
  const groupKey = alternatives.length > 1 ? alternativeGroupKey(Number(dayRecord.day), alternatives.map((index) => {
    const peer = objectValue(allSpots[index]); return typeof peer.name === "string" ? peer.name : "";
  })) : undefined;
  const remaining = dayRecord.spots.filter((_, index) => index !== input.spotIndex); dayRecord.spots = remaining;
  const dayNumber = Number(dayRecord.day);
  if (spotName && Number.isInteger(dayNumber) && dayNumber > 0) {
    appendTrustedOperatorItineraryRemoval(next, dayNumber, spotName, new Date().toISOString(), groupKey);
    normaliseRemainingAlternativeRelation(remaining, alternatives, input.spotIndex);
  }
  if (spotName && Array.isArray(dayRecord.activities)) removeMatchingActivity(dayRecord, spotName);
  return next;
}

function locationText(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function removeMatchingActivity(day: Json, spotName: string): void {
  let removed = false;
  day.activities = (day.activities as unknown[]).filter((activity) => {
    if (removed || !activity || typeof activity !== "object" || Array.isArray(activity)) return true;
    const record = activity as Json; const title = typeof record.title === "string" ? record.title.trim() : "";
    const type = typeof record.type === "string" ? record.type : undefined;
    if (title === spotName && (type === undefined || type === "visit" || type === "other")) { removed = true; return false; }
    return true;
  });
}
function normaliseRemainingAlternativeRelation(spots: unknown[], group: readonly number[], removedIndex: number): void {
  const alternatives = group.filter((index) => index !== removedIndex).map((index) => spots[index > removedIndex ? index - 1 : index])
    .filter((spot): spot is Json => Boolean(spot) && typeof spot === "object" && !Array.isArray(spot));
  if (alternatives.length === 1) alternatives[0]!.relation = "and";
}
function alternativeGroupIndexes(spots: readonly unknown[], index: number): number[] {
  const current = objectValue(spots[index]); if (current.relation !== "or") return [];
  const time = current.timeOfDay; const isPeer = (value: unknown) => { const spot = objectValue(value); return spot.relation === "or" && spot.timeOfDay === time; };
  let start = index; let end = index;
  while (start > 0 && isPeer(spots[start - 1])) start -= 1;
  while (end + 1 < spots.length && isPeer(spots[end + 1])) end += 1;
  return Array.from({ length: end - start + 1 }, (_, offset) => start + offset);
}
