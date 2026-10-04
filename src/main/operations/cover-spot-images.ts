import type { CtripLibraryCoverAlternate, CtripLibraryImageCandidate, ItinerarySpot } from "../../shared/contracts-types.js";
import { buildCtripLibraryCoverAlternateFromCandidate } from "./cover-auto-fill-images.js";
const SPOT_IMAGE_TARGET_COUNT = 10;
const safeObject = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const textValue = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const positiveInteger = (value: unknown): boolean => typeof value === "number" && Number.isInteger(value) && value > 0;
function isCoverCandidateComplete(candidate: CtripLibraryImageCandidate): candidate is CtripLibraryImageCandidate & { imageId: number; imageUrl: string } {
  return positiveInteger(candidate.imageId) && Boolean(textValue(candidate.imageUrl)) && candidate.imageResolved === true;
}

/**
 * 阶段三 helper：从候选池中收集「未进封面」的图，按 POI 归属写入对应 spot.images。
 *   - 若没有任何剩余图需要写入，返回 null（调用方不需要更新 itinerary）；
 *   - 写回时只对真正变化了的 day / spot 重新构造对象，未变化的 day 保持原引用。
 */
export function collectSpotImageResiduals(args: {
  product: Record<string, unknown>;
  pools: Array<{ keyword: string; candidates: CtripLibraryImageCandidate[] }>;
  coverUsedImageIds: Set<number>;
  existingCover: Record<string, unknown> | null;
  now: () => string;
}): Array<Record<string, unknown>> | null {
  const { product, pools, coverUsedImageIds, existingCover, now } = args;
  if (pools.length === 0) return null;
  if (!Array.isArray(product.itinerary) || product.itinerary.length === 0) return null;

  // 按 dayIndex:spotIndex 累计剩余图。
  const residualBySpot = new Map<string, CtripLibraryCoverAlternate[]>();
  for (const pool of pools) {
    for (const candidate of pool.candidates) {
      if (!isCoverCandidateComplete(candidate)) continue;
      if (coverUsedImageIds.has(candidate.imageId)) continue;
      const matched = findSpotForCandidate(product, candidate);
      if (!matched) continue;
      const key = `${matched.dayIndex}:${matched.spotIndex}`;
      const list = residualBySpot.get(key) ?? [];
      if (list.length >= SPOT_IMAGE_TARGET_COUNT) continue;
      list.push(buildCtripLibraryCoverAlternateFromCandidate({
        existingCover,
        candidate,
        keyword: pool.keyword,
        selectedAt: now(),
      }));
      residualBySpot.set(key, list);
    }
  }
  if (residualBySpot.size === 0) return null;

  // 构造新的 itinerary：只对真正写入的 day / spot 做不可变更新。
  const originalDays = product.itinerary as Array<Record<string, unknown>>;
  let mutated = false;
  const nextDays = originalDays.map((day, dayIndex) => {
    if (!isRecord(day) || !Array.isArray(day.spots)) return day;
    const originalSpots = day.spots as Array<Record<string, unknown>>;
    let dayMutated = false;
    const nextSpots = originalSpots.map((spot, spotIndex) => {
      if (!isRecord(spot)) return spot;
      const images = residualBySpot.get(`${dayIndex}:${spotIndex}`);
      if (!images || images.length === 0) return spot;
      dayMutated = true;
      return { ...spot, images };
    });
    if (!dayMutated) return day;
    mutated = true;
    return { ...day, spots: nextSpots };
  });
  return mutated ? nextDays : null;
}

/**
 * 把 candidate 映射到 itinerary 中的某个 spot。
 * 匹配规则（与 matchesItineraryCoverPoi 共享一套语义但更宽容）：
 *   1) candidate.poiId === spot.poiId（正整数相等）；
 *   2) candidate.poiName 与 spot.name / spot.poiName 互含（任一非空即匹配）；
 *   3) 都缺则不匹配（无证据证明属于行程中的某个景点）。
 * 返回首个匹配项的索引 + 引用；找不到返回 null。
 */
function findSpotForCandidate(
  product: Record<string, unknown>,
  candidate: CtripLibraryImageCandidate,
): { dayIndex: number; spotIndex: number; spot: ItinerarySpot } | null {
  if (!Array.isArray(product.itinerary)) return null;
  const candidatePoiId = positiveInteger(candidate.poiId);
  const candidateName = textValue(candidate.poiName);
  for (let dayIndex = 0; dayIndex < product.itinerary.length; dayIndex += 1) {
    const day = safeObject(product.itinerary[dayIndex]);
    if (!day || !Array.isArray(day.spots)) continue;
    for (let spotIndex = 0; spotIndex < day.spots.length; spotIndex += 1) {
      const raw = day.spots[spotIndex];
      const spot = safeObject(raw) as ItinerarySpot | null;
      if (!spot) continue;
      // 字符串 spot 不支持 images 写入，跳过。
      if (typeof raw === "string") continue;
      // 1) poiId 相等优先。
      if (candidatePoiId && positiveInteger(spot.poiId) === candidatePoiId) {
        return { dayIndex, spotIndex, spot };
      }
      // 2) poiName / name 互含。
      if (candidateName) {
        const spotName = textValue(spot.name);
        const spotPoiName = textValue(spot.poiName);
        if (spotName && (candidateName === spotName || candidateName.includes(spotName) || spotName.includes(candidateName))) {
          return { dayIndex, spotIndex, spot };
        }
        if (spotPoiName && (candidateName === spotPoiName || candidateName.includes(spotPoiName) || spotPoiName.includes(candidateName))) {
          return { dayIndex, spotIndex, spot };
        }
      }
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
