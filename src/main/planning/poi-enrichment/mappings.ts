/**
 * POI 补全阶段的受控核验凭证与括号别名。
 *
 * 从 poi-enrichment.ts 拆出以守住单文件行数上限；行为与原实现一致，
 * 仅在凭证里附带被核验景点的 spotId（景点没有合法 ID 时不补造）。
 */

import { isItinerarySpotId } from "../../../shared/itinerary-spot-identity.js";
import type { OrchestratorRuntime, VerifiedPoiMapping } from "../types.js";

export function recordVerifiedMapping(
  mappings: VerifiedPoiMapping[],
  runtime: OrchestratorRuntime,
  day: Record<string, unknown>,
  spot: unknown,
  spotName: string,
  match: { poiName: string; poiId: number; province?: string; city?: string; district?: string },
): void {
  // 只有生产受控选择器能证明候选上下文、营业状态与置信度；
  // 单纯的 suggestPoi 结果不能结清运营决策门。
  if (!runtime.resolvePoiSelection) return;
  const dayNumber = Number(day.day);
  if (!Number.isInteger(dayNumber) || dayNumber <= 0) return;
  const spotId = spot && typeof spot === "object" && !Array.isArray(spot)
    ? (spot as Record<string, unknown>).spotId : undefined;
  mappings.push({ day: dayNumber, ...(isItinerarySpotId(spotId) ? { spotId } : {}), spotName, ...match });
}

export function bracketAliases(value: string): string[] {
  const aliases = Array.from(value.matchAll(/[（(]([^）)]+)[）)]/g), (match) => match[1].trim());
  return [...new Set(aliases.filter((alias) => alias && alias !== value.trim()))];
}
