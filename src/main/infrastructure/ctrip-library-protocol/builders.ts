/**
 * 携程图库请求构造 + 响应解析：
 *   - buildSuggestPoiRequest / buildSearchImageRequest：纯函数，请求体完全按真实
 *     样本固化（searchImage 必传 District / PoiId / Country 三 tag，sources [1,9]，
 *     urlOptions 200/500 两档 R 类型，auditStatuses [4]，excludeGif true）；
 *   - parseSuggestPoiPayload：旧 single-stage 兼容，最小 poi（poiId + poiName）；
 *   - parseSuggestPoiPlaces：新两阶段链路，带可选 address / province / city /
 *     district 字段；
 *   - parseSearchImagePayload：从 imageIds / imageList / images / body / data.*
 *     多形态里取 imageId 列表；相同 ID 仅保留首个（dedup）。
 */

import type {
  SearchImageRequest,
  SearchImageResponse,
  SuggestPoiPlacesResult,
  SuggestPoiRequest,
  SuggestPoiResponse,
} from "./types.js";
import { clampPageSize, emptyHead } from "./endpoints.js";
import {
  failureReason,
  isBusinessSuccess,
  parsePoiFromEntry,
  pickImageList,
  pickPoiList,
  positiveInteger,
  readImageId,
} from "./parse-helpers.js";

export function buildSuggestPoiRequest(keyword: string): SuggestPoiRequest {
  const trimmed = keyword.trim();
  if (!trimmed) throw new Error("查询携程图库必须提供景点关键词。");
  return {
    contentType: "json",
    head: emptyHead(),
    keyword: trimmed,
    orderType: "",
  };
}

export function buildSearchImageRequest(args: {
  poiId: number;
  pageSize?: number;
  sources?: ReadonlyArray<number>;
}): SearchImageRequest {
  if (!Number.isInteger(args.poiId) || args.poiId <= 0) {
    throw new Error("searchImage 必须传入正整数 poiId。");
  }
  const pageSize = clampPageSize(args.pageSize ?? 20);
  return {
    contentType: "json",
    head: emptyHead(),
    tags: [
      { tagType: "District", tagValue: "" },
      { tagType: "PoiId", tagValue: String(args.poiId) },
      { tagType: "Country", tagValue: "" },
    ],
    sources: args.sources ?? [1, 9],
    urlOptions: [
      { width: 200, height: 200, quality: 0.9, type: "R" },
      { width: 500, height: 500, quality: 0.9, type: "R" },
    ],
    imageClass: "TourProduct",
    pageIndex: 1,
    pageSize,
    auditStatuses: [4],
    excludeGif: true,
  };
}

export function parseSuggestPoiPayload(payload: unknown, httpStatus = 200): SuggestPoiResponse {
  const root = parseRoot(payload);
  const responseStatus = root.status;
  const ack = responseStatus?.Ack;
  if (!isBusinessSuccess(ack)) {
    throw new Error(`suggestPoi 业务失败：${failureReason(responseStatus)}`);
  }
  const list = pickPoiList(root.record);
  for (const entry of list) {
    const poi = parseRoot(entry).record;
    if (!poi) continue;
    // 旧 single-stage 兼容：返回最小 poi（仅 poiId + poiName），不携带 address /
    // province / city / district 等可选字段；这些字段由 parseSuggestPoiPlaces
    // 单独承担，避免破坏测试断言与已有契约。
    const parsed = parsePoiFromEntry(poi);
    if (!parsed) continue;
    return {
      httpStatus,
      businessStatus: String(ack ?? "Success"),
      poi: { poiId: parsed.poiId, poiName: parsed.poiName },
    };
  }
  return { httpStatus, businessStatus: String(ack ?? "Success"), poi: null };
}

export function parseSuggestPoiPlaces(payload: unknown, httpStatus = 200): SuggestPoiPlacesResult {
  const root = parseRoot(payload);
  const responseStatus = root.status;
  const ack = responseStatus?.Ack;
  if (!isBusinessSuccess(ack)) {
    throw new Error(`suggestPoi 业务失败：${failureReason(responseStatus)}`);
  }
  const list = pickPoiList(root.record);
  const places: import("./types.js").SuggestPoiParsedPoi[] = [];
  const seen = new Set<number>();
  for (const entry of list) {
    const poi = parseRoot(entry).record;
    if (!poi) continue;
    const parsed = parsePoiFromEntry(poi);
    if (!parsed) continue;
    if (seen.has(parsed.poiId)) continue;
    seen.add(parsed.poiId);
    places.push(parsed);
  }
  return { httpStatus, businessStatus: String(ack ?? "Success"), places };
}

export function parseSearchImagePayload(payload: unknown, httpStatus = 200): SearchImageResponse {
  const root = parseRoot(payload);
  const responseStatus = root.status;
  const ack = responseStatus?.Ack;
  if (!isBusinessSuccess(ack)) {
    throw new Error(`searchImage 业务失败：${failureReason(responseStatus)}`);
  }
  const list = pickImageList(root.record);
  const seen = new Set<number>();
  const imageIds: number[] = [];
  for (const entry of list) {
    const id = positiveInteger(readImageId(entry)) ?? readImageId(entry);
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    imageIds.push(id);
  }
  return {
    httpStatus,
    businessStatus: String(ack ?? "Success"),
    imageIds,
  };
}

function parseRoot(value: unknown): { record: Record<string, unknown> | null; status: Record<string, unknown> | null } {
  const record = (value && typeof value === "object" && !Array.isArray(value))
    ? (value as Record<string, unknown>)
    : null;
  const status = record && record.ResponseStatus && typeof record.ResponseStatus === "object" && !Array.isArray(record.ResponseStatus)
    ? (record.ResponseStatus as Record<string, unknown>)
    : null;
  return { record, status };
}