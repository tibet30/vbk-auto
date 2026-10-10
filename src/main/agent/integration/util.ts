/**
 * integration 共用工具 + 不依赖 tool 工厂的小函数：
 *   - JsonObject / productData / cleanText / safeJson / requirePatch / positiveInteger
 *     / absentTravelNodeResearchTask；
 *   - applyResolvedItineraryHotels：把酒店候选 + 资源来源写入 operations.hotelResource
 *     + 同步 itinerary.hotels（reconcileResolvedHotelCopy）；
 *   - selectItinerarySpot：从 product.itinerary 里按 day + name（精确或前后缀）找
 *     单个 spot，给 select_itinerary_poi 工具用；
 *   - clearUnverifiedItineraryPois：清掉未经核验的 poiId / poiName，并把 string spots
 *     规整为 { name, poiName: null, poiId: null }，避免直接写产品；
 *
 * 大件 createAgentBusinessTools 在 tools.ts。
 */

import type { ProductDetail } from "../../../shared/contracts.js";
import { isTravelNodeName } from "../../planning/itinerary-adoption.js";
import { reconcileResolvedHotelCopy } from "../hotel-candidate-recovery.js";

export type JsonObject = Record<string, unknown>;

export function productData(product: ProductDetail): JsonObject { return product.product as JsonObject; }
export function cleanText(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
export function safeJson(value: unknown): string { return JSON.stringify(value, null, 2).slice(0, 24_000); }

export function requirePatch(args: JsonObject): JsonObject {
  const patch = args.patch;
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("patch 必须是对象。");
  const allowed = new Set(["basicInfo", "presentation", "itinerary", "operations", "commercial"]);
  for (const key of Object.keys(patch)) if (!allowed.has(key)) throw new Error(`不允许修改字段：${key}`);
  return patch as JsonObject;
}

export function positiveInteger(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${label}必须是正整数。`);
  return number;
}

export function absentTravelNodeResearchTask(label: string, presentSpotNames: ReadonlySet<string>): boolean {
  const match = label.match(/^核查\s+(.+?)\s+的\s+VBK\s+POI\s+映射$/i);
  const name = match?.[1]?.trim() ?? "";
  return Boolean(name && isTravelNodeName(name) && !presentSpotNames.has(name));
}

/**
 * 酒店检索是受控资源核验，不应只写 itinerary。把候选和资源来源一起保存，
 * 才能让后续阶段可靠地进入 hotelResource，而不是被旧的 nonPlatform 标签跳过。
 */
export function applyResolvedItineraryHotels(
  product: JsonObject,
  resolved: Awaited<ReturnType<typeof import("../../infrastructure/ctrip-hotel-search.js").resolveItineraryHotelCandidates>>,
): JsonObject {
  const first = resolved.dailyCandidates[0]?.candidates[0];
  if (!first) throw new Error("酒店候选为空，无法写入酒店资源。");
  const operations = product.operations && typeof product.operations === "object" && !Array.isArray(product.operations)
    ? product.operations as JsonObject
    : {};
  return {
    ...structuredClone(product),
    itinerary: resolved.itinerary.map((day) => reconcileResolvedHotelCopy(day as JsonObject)),
    operations: {
      ...operations,
      hotelResource: {
        source: "ctrip",
        resourceId: first.hotelId,
        resourceName: first.hotelName,
        diamond: first.diamond,
        candidates: resolved.dailyCandidates[0]!.candidates,
        dailyCandidates: resolved.dailyCandidates,
      },
    },
  };
}

export function selectItinerarySpot(product: ProductDetail, day: number, spotName: string) {
  const itinerary = Array.isArray(product.product.itinerary) ? product.product.itinerary as JsonObject[] : [];
  const dayIndex = itinerary.findIndex((item) => Number(item.day) === day);
  if (dayIndex < 0) throw new Error(`未找到第 ${day} 天行程。`);
  const spots = Array.isArray(itinerary[dayIndex]?.spots) ? itinerary[dayIndex].spots as unknown[] : [];
  const candidates = spots
    .map((spot, spotIndex) => ({ spot, spotIndex }))
    .filter((item): item is { spot: JsonObject; spotIndex: number } =>
      Boolean(item.spot) && typeof item.spot === "object" && !Array.isArray(item.spot));
  const matches = candidates.filter(({ spot }) => cleanText(spot.name) === spotName || cleanText(spot.poiName) === spotName);
  const suffixMatches = matches.length === 0
    ? candidates.filter(({ spot }) => {
      const names = [cleanText(spot.name), cleanText(spot.poiName)].filter(Boolean);
      return names.some((name) => name.endsWith(spotName) || spotName.endsWith(name));
    })
    : matches;
  if (suffixMatches.length !== 1) throw new Error(suffixMatches.length ? `第 ${day} 天存在多个「${spotName}」，请先调整名称。` : `第 ${day} 天未找到景点「${spotName}」。`);
  return { dayIndex, spotIndex: suffixMatches[0]!.spotIndex, spot: suffixMatches[0]!.spot };
}

/** Strip unverified POI ids from a freshly generated itinerary without crashing on sparse/string spots. */
export function clearUnverifiedItineraryPois(itinerary: unknown): void {
  if (!Array.isArray(itinerary)) return;
  for (const day of itinerary) {
    if (!day || typeof day !== "object" || Array.isArray(day)) continue;
    const spots = (day as JsonObject).spots;
    if (!Array.isArray(spots)) continue;
    for (let index = 0; index < spots.length; index += 1) {
      const spot = spots[index];
      if (typeof spot === "string") {
        const name = spot.trim();
        spots[index] = name ? { name, poiName: null, poiId: null } : null;
        continue;
      }
      if (!spot || typeof spot !== "object" || Array.isArray(spot)) continue;
      (spot as JsonObject).poiId = null;
      (spot as JsonObject).poiName = null;
    }
    (day as JsonObject).spots = spots.filter((spot) => spot && typeof spot === "object" && !Array.isArray(spot));
  }
}