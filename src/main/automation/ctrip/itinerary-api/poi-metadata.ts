/** 保存行程前按 poiId 回查 suggestPoi，补齐 VBK 校验依赖的类型字段。 */

import { buildPoiSuggestRequest } from "../../../infrastructure/poi-suggest.js";
import { vbkSessionRequest } from "../../../infrastructure/vbk-session-request.js";
import type { ApiPage } from "./transport.js";
import type { ProductItineraryDay } from "./itinerary-transform.js";

type PoiCandidate = {
  poiId?: unknown;
  poiType?: { key?: unknown; name?: unknown } | null;
  ticketType?: { key?: unknown; name?: unknown } | null;
};

function candidatesFrom(payload: unknown): PoiCandidate[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const body = payload as Record<string, unknown>;
  if (Array.isArray(body.poiList)) return body.poiList as PoiCandidate[];
  const data = body.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const list = (data as Record<string, unknown>).poiList;
    if (Array.isArray(list)) return list as PoiCandidate[];
  }
  return [];
}

export async function enrichItineraryPoiMetadata(
  page: ApiPage,
  itinerary: ProductItineraryDay[],
): Promise<ProductItineraryDay[]> {
  const cache = new Map<number, {
    poiType: { key: number; name: string };
    ticketType: { key: number; name: string } | null;
    poiData: Record<string, unknown>;
  }>();
  const enriched: ProductItineraryDay[] = [];
  for (const day of itinerary) {
    const spots = [];
    for (const spot of day.spots ?? []) {
      const poiId = typeof spot.poiId === "number" ? spot.poiId : 0;
      const keyword = String(spot.poiName || spot.name || "").trim();
      if (!poiId || !keyword) throw new Error(`景点缺 poiId/poiName，无法回查类型：${JSON.stringify(spot)}`);
      let metadata = cache.get(poiId);
      if (!metadata) {
        const result = await vbkSessionRequest(page, {
          endpoint: "https://online.ctrip.com/restapi/soa2/20049/suggestPoi",
          body: buildPoiSuggestRequest(keyword),
          browserRequestTimeoutMs: 12_000,
          evaluateTimeoutMs: 15_000,
          errorLabel: "VBK 行程 POI 类型查询",
          includeCidQuery: false,
        });
        const match = candidatesFrom(result.payload).find((candidate) => String(candidate.poiId) === String(poiId));
        if (!match?.poiType || typeof match.poiType.key !== "number") {
          throw new Error(`VBK suggestPoi 未返回 poiId=${poiId}（${keyword}）的有效 poiType`);
        }
        metadata = {
          poiType: { key: match.poiType.key, name: String(match.poiType.name ?? "") },
          ticketType: match.ticketType && typeof match.ticketType.key === "number"
            ? { key: match.ticketType.key, name: String(match.ticketType.name ?? "") }
            : null,
          poiData: { ...(match as Record<string, unknown>) },
        };
        cache.set(poiId, metadata);
      }
      spots.push({ ...spot, ...metadata });
    }
    enriched.push({ ...day, spots });
  }
  return enriched;
}
