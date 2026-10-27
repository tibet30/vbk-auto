import type { OrchestratorRuntime } from "../types.js";
import { logInfo, logWarn } from "../../../shared/log-timestamp.js";
import { hasCompletePoi, requiresItineraryPoi } from "../../../shared/itinerary-activity-kind.js";
import type { PoiSelectionReason } from "../../../shared/poi-research-outcome.js";
import { isCompatiblePoiIdentity } from "../../../shared/poi-candidate-identity.js";

const DEFAULT_AVAILABILITY_TIMEOUT_MS = 16_000;

export async function queryPoi(args: {
  runtime: OrchestratorRuntime;
  localProductId: string;
  keyword: string;
  queryTimeoutMs: number;
  context?: { destinationCity?: string; province?: string };
  itinerary?: unknown[];
}): Promise<{
  match: PoiMatch | null;
  failed: boolean;
  suspended: boolean;
  reason?: PoiSelectionReason;
}> {
  try {
    logInfo("[planning.poi]", { event: "query-start", localProductId: args.localProductId, keyword: args.keyword });
    if (args.runtime.resolvePoiSelection) {
      const selected = await rejectPoiQueryAfter(
        args.runtime.resolvePoiSelection(args.localProductId, args.keyword, args.context, args.itinerary),
        args.queryTimeoutMs,
      );
      return {
        match: selected.status === "available" && selected.match ? normalisePoiMatch(selected.match) : null,
        failed: false,
        suspended: selected.status === "suspended",
        reason: selected.reason,
      };
    }
    const candidate = await rejectPoiQueryAfter(args.runtime.suggestPoi!(args.keyword, args.context), args.queryTimeoutMs);
    const availability = candidate ? await queryPoiAvailability(args.runtime, args.localProductId, candidate.poiId, args.queryTimeoutMs) : null;
    return {
      match: availability === "suspended" || availability === "unverified" ? null : normalisePoiMatch(candidate),
      failed: availability === "unverified",
      suspended: availability === "suspended",
      reason: undefined,
    };
  } catch (error) {
    logWarn("[planning.poi]", {
      event: "query-failed",
      localProductId: args.localProductId,
      keyword: args.keyword,
      error: error instanceof Error ? error.message : String(error),
    });
    return { match: null, failed: true, suspended: false, reason: undefined };
  }
}
type PoiMatch = { poiName: string; poiId: number; province?: string; city?: string; district?: string; latitude?: number; longitude?: number };

function normalisePoiMatch(match: { poiName?: unknown; poiId?: unknown; province?: unknown; city?: unknown; district?: unknown; latitude?: unknown; longitude?: unknown } | null | undefined): PoiMatch | null {
  if (!match || typeof match !== "object") return null;
  const poiName = match.poiName;
  const poiId = match.poiId;
  if (!hasText(poiName) || !isPositiveInteger(poiId)) return null;
  if (isTravelNodeName(poiName)) return null;
  return {
    poiName: poiName.trim(), poiId,
    ...(hasText(match.province) ? { province: match.province.trim() } : {}),
    ...(hasText(match.city) ? { city: match.city.trim() } : {}),
    ...(hasText(match.district) ? { district: match.district.trim() } : {}),
    ...(isFiniteNumber(match.latitude) && isFiniteNumber(match.longitude) ? { latitude: match.latitude, longitude: match.longitude } : {}),
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function applyPoiMatch(spot: Record<string, unknown>, match: PoiMatch): void {
  spot.poiName = match.poiName;
  spot.poiId = match.poiId;
  if (match.province) spot.province = match.province;
  if (match.city) spot.city = match.city;
  if (match.district) spot.district = match.district;
  if (match.latitude !== undefined && match.longitude !== undefined) {
    spot.latitude = match.latitude;
    spot.longitude = match.longitude;
  } else {
    delete spot.latitude;
    delete spot.longitude;
  }
}

export async function queryPoiAvailability(runtime: OrchestratorRuntime, localProductId: string, poiId: unknown, timeoutMs = DEFAULT_AVAILABILITY_TIMEOUT_MS): Promise<"available" | "suspended" | "unverified" | null> {
  if (!runtime.getPoiAvailability || !isPositiveInteger(poiId)) return null;
  try {
    return (await rejectPoiQueryAfter(runtime.getPoiAvailability(poiId), timeoutMs)).status;
  } catch (error) {
    logWarn("[planning.poi]", {
      event: "availability-query-failed",
      localProductId,
      poiId,
      error: error instanceof Error ? error.message : String(error),
    });
    return "unverified";
  }
}

export async function queryItineraryPoiAvailabilities(
  runtime: OrchestratorRuntime,
  localProductId: string,
  itinerary: any[],
  shouldReviewCompletePois: boolean,
  timeoutMs = DEFAULT_AVAILABILITY_TIMEOUT_MS,
): Promise<Map<number, "available" | "suspended">> {
  if (!shouldReviewCompletePois || !runtime.getPoiAvailabilities) return new Map();
  const poiIds = itinerary.flatMap((day) => Array.isArray(day?.spots) ? day.spots : [])
    .filter((spot) => requiresItineraryPoi(spot as Record<string, unknown>) && hasCompletePoi(spot as Record<string, unknown>))
    .map((spot) => spot.poiId as number);
  if (poiIds.length === 0) return new Map();
  try {
    const result = await rejectPoiQueryAfter(runtime.getPoiAvailabilities(poiIds), timeoutMs);
    return new Map([...result.entries()].map(([poiId, value]) => [poiId, value.status]));
  } catch (error) {
    logWarn("[planning.poi]", {
      event: "availability-batch-query-failed",
      localProductId,
      poiCount: new Set(poiIds).size,
      error: error instanceof Error ? error.message : String(error),
    });
    return new Map();
  }
}

/**
 * 历史绑定没有坐标，路线走廊证据无从计算。复核前按官方名只读回查同一 poiId 的
 * 平台坐标；查询失败或回查不到同一 ID 时保持原样，由地域门禁按缺证据处理。
 */
export async function backfillItineraryPoiCoordinates(runtime: OrchestratorRuntime, localProductId: string,
  itinerary: any[], timeoutMs = DEFAULT_AVAILABILITY_TIMEOUT_MS): Promise<boolean> {
  if (!runtime.getPoiCoordinates) return false;
  let changed = false;
  const cache = new Map<number, { latitude: number; longitude: number } | undefined>();
  for (const spot of itinerary.flatMap((day) => Array.isArray(day?.spots) ? day.spots : [])) {
    if (!spot || typeof spot !== "object" || !hasCompletePoi(spot) || !requiresItineraryPoi(spot)) continue;
    if (isFiniteNumber(spot.latitude) && isFiniteNumber(spot.longitude)) continue;
    // 身份已不符的旧绑定会在复核中清除，不必为它取坐标。
    if (!isCompatiblePoiIdentity(String(spot.name ?? ""), String(spot.poiName))) continue;
    const poiId = Number(spot.poiId);
    if (!cache.has(poiId)) {
      try {
        // 用原景点名查询：与复核本身发出的查询一致，不额外产生新的平台请求形态。
        const name = String(spot.name ?? "").trim() || String(spot.poiName).trim();
        cache.set(poiId, await rejectPoiQueryAfter(runtime.getPoiCoordinates(name, poiId), timeoutMs));
      } catch (error) {
        logWarn("[planning.poi]", { event: "coordinate-backfill-failed", localProductId, poiId,
          error: error instanceof Error ? error.message : String(error) });
        cache.set(poiId, undefined);
      }
    }
    const point = cache.get(poiId);
    if (point) { spot.latitude = point.latitude; spot.longitude = point.longitude; changed = true; }
  }
  return changed;
}

export function isTravelNodeName(value: string): boolean {
  return /(机场|航站楼|火车站|高铁站|动车站|汽车站|客运站|码头|酒店|宾馆|民宿|客栈|集合点|接送点|接机点|送机点|接站点|送站点)/.test(value.trim());
}
function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
function rejectPoiQueryAfter<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`VBK POI 查询超时（${timeoutMs}ms）`)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}
