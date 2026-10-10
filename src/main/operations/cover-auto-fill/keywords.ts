/**
 * cover-auto-fill 的搜 POI 关键词工具：
 *   - matchesItineraryCoverPoi：candidate 是否与行程 POI 匹配（按 poiId 或 poiName）；
 *   - pickCoverSearchKeyword：单数版本（保留以兼容旧测试 / 旧 import）；
 *   - collectCoverSearchKeywords：复数版本，按 cover.poi > itinerary[].spots 顺序收集去重关键词。
 */

import type { CtripLibraryImageCandidate } from "../../../shared/contracts-types.js";
import { requiresItineraryPoi } from "../../../shared/itinerary-activity-kind.js";
import { itineraryAttractions } from "../../../shared/itinerary-activity-kind.js";
import { positiveInteger, safeObject, textValue } from "./predicates.js";

/**
 * 候选图片是否与行程 POI 匹配：
 *   - candidate.poiId 命中 itinerary 已知 POI → true；
 *   - 否则比较 poiName 与 keyword；
 *   - candidateName 为空时，仅当 itinerary 无 POI ID 才返回 true（兜底"无 POI ID 时允许匿名"）。
 */
export function matchesItineraryCoverPoi(
  candidate: CtripLibraryImageCandidate,
  keyword: string,
  product: Record<string, unknown>,
): boolean {
  const itinerary = Array.isArray(product.itinerary) ? product.itinerary : [];
  const spots = itinerary.flatMap((day) => {
    const record = safeObject(day);
    return Array.isArray(record?.spots) ? record.spots : [];
  }).map(safeObject).filter((spot): spot is Record<string, unknown> => Boolean(spot));
  const attractionSpots = itineraryAttractions(spots);
  const knownPoiIds = new Set(attractionSpots.map((spot) => spot.poiId).filter(positiveInteger));
  if (positiveInteger(candidate.poiId) && knownPoiIds.size) return knownPoiIds.has(candidate.poiId);
  const candidateName = textValue(candidate.poiName);
  // Some gallery rows omit their POI name after image resolution. Allow that
  // only when the itinerary has no bound POI IDs yet; otherwise a nameless
  // candidate cannot prove it belongs to the known itinerary set.
  if (!candidateName) return knownPoiIds.size === 0;
  return candidateName === keyword || candidateName.includes(keyword) || keyword.includes(candidateName);
}

/**
 * 决定搜 POI 的关键词（单数版本，保留以兼容旧测试 / 旧 import）：
 *   - 优先用 cover.poi（用户/AI 显式给出的代表景点）；
 *   - 否则按行程顺序遍历 itinerary[].spots[].name / poiName；
 *   - 都没有 → 返回 null（调用方放弃，不写半成品 cover）。
 */
export function pickCoverSearchKeyword(product: Record<string, unknown>): string | null {
  const keywords = collectCoverSearchKeywords(product);
  return keywords && keywords.length > 0 ? keywords[0] : null;
}

/**
 * 收集一组有序且去重的搜 POI 关键词：
 *   1. cover.poi 优先：用户/AI 显式给的代表景点作为首选关键词纳入；
 *      不再短路返回——若首个 POI 搜索无图 / 候选不完整，applyAutoCoverFill
 *      会按顺序尝试 itinerary 后续 POI（避免"代表景点无图就放弃"）。
 *   2. cover.poi 之后按以下顺序全收集（首次出现优先 + 大小写不敏感去重）：
 *        - itinerary[].spots[*]：按行程顺序，每个 spot 支持
 *          - 字符串；
 *          - { name }；
 *          - { poiName }；
 *        - 不用 day title、城市、商品名或文案兜底：封面检索只以景点 POI 为依据。
 *   3. 全部为空 → null（调用方放弃，不写半成品 cover）。
 */
export function collectCoverSearchKeywords(product: Record<string, unknown>): string[] | null {
  const presentation = safeObject(product.presentation);
  const cover = safeObject(presentation?.cover);
  const coverPoi = textValue(cover?.poi);

  const seen = new Set<string>();
  const result: string[] = [];

  const push = (raw: unknown): boolean => {
    const value = textValue(raw);
    if (!value) return false;
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    result.push(value);
    return true;
  };

  // cover.poi 显式给的：作为首选关键词纳入，但不短路返回；继续收集
  // itinerary spots 等后续关键词，便于首个 POI 在搜索无图/候选不完整时回退
  // 到其它具名景点（applyAutoCoverFill 会按顺序逐个尝试）。
  push(coverPoi);

  const itinerary = Array.isArray(product.itinerary) ? product.itinerary as Array<Record<string, unknown>> : [];
  for (const day of itinerary) {
    const dayRecord = safeObject(day);
    const spots = Array.isArray(dayRecord?.spots) ? dayRecord.spots as Array<unknown> : [];
    for (const spot of spots) {
      if (typeof spot === "string") {
        push(spot);
        continue;
      }
      const spotRecord = safeObject(spot);
      if (!spotRecord) continue;
      if (!requiresItineraryPoi(spotRecord)) continue;
      // 同一 spot 内 name > poiName 优先，去重由 push 内部保证。
      push(spotRecord.name) || push(spotRecord.poiName);
    }
  }

  return result.length > 0 ? result : null;
}