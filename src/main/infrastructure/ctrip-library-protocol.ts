/**
 * 携程图库 suggestPoi / searchImage 请求与解析协议。
 */
import type {
  CtripLibraryImageCandidate,
  CtripLibraryPlaceCandidate,
} from "../../shared/contracts-types.js";
import type { PoiSuggestBrowser } from "./poi-suggest.js";
import {
  EMPTY_COVER_PLACE_SEARCH_CONTEXT,
  type CoverPlaceSearchSessionContext,
} from "./cover-place-search-logger.js";

/** suggestpoi.json 接口地址（VBK 图库关键词 → POI ID）。 */
export const SUGGESTPOI_ENDPOINT =
  "https://online.ctrip.com/restapi/soa2/15638/suggestpoi.json";

/**searchImage 接口地址（POI ID → imageId 列表）。 */
export const SEARCH_IMAGE_ENDPOINT =
  "https://online.ctrip.com/restapi/soa2/12719/searchImage";

/** 浏览器侧 fetch 默认超时（毫秒）。 */
export const CTRIP_LIBRARY_BROWSER_REQUEST_TIMEOUT_MS = 12_000;
/** BrowserView evaluate 自身悬挂时主进程的兜底超时（毫秒）。 */
export const CTRIP_LIBRARY_EVALUATE_TIMEOUT_MS = 15_000;
/** searchImage 单页拉取上限；超出会被后端拒，本地先裁剪。 */
export const SEARCH_IMAGE_MAX_PAGE_SIZE = 50;
export const CTRIP_LIBRARY_REFERRER =
  "https://vbooking.ctrip.com/product/input/productImageText?pattern=1&from=vbk";

export interface CtripLibrarySearchBrowser
  extends Pick<PoiSuggestBrowser, "evaluate"> {}

/** 同 VBK SOA 其它接口的 head 字段族：cid 留空字符串，由 evaluate 内联读取 cookie 注入。 */
export interface CtripLibraryRequestHead {
  cid: string;
  ctok: string;
  cver: string;
  lang: string;
  sid: string;
  syscode: string;
  auth: string;
  xsid: string;
  extension: unknown[];
}

export interface SuggestPoiRequest {
  contentType: "json";
  head: CtripLibraryRequestHead;
  keyword: string;
  orderType: string;
}

export interface SearchImageRequest {
  contentType: "json";
  head: CtripLibraryRequestHead;
  tags: ReadonlyArray<{
    tagType: "District" | "PoiId" | "Country";
    tagValue: string;
  }>;
  sources: ReadonlyArray<number>;
  urlOptions: ReadonlyArray<{
    width: number;
    height: number;
    quality: number;
    type: string;
  }>;
  imageClass: string;
  pageIndex: number;
  pageSize: number;
  auditStatuses: ReadonlyArray<number>;
  excludeGif: boolean;
}

export interface SuggestPoiParsedPoi {
  /** 候选 POI ID（>0 的整数）。 */
  poiId: number;
  /** 候选 POI 名称；用于上层在 UI 显示「匹配到的景点」/ 写入 cover.poiName。 */
  poiName: string;
  /** 可选：完整地址文本。 */
  address?: string | null;
  province?: string | null;
  city?: string | null;
  district?: string | null;
}

export interface SuggestPoiResponse {
  httpStatus: number;
  businessStatus: string;
  poi: SuggestPoiParsedPoi | null;
}

/** suggestPoi 完整解析结果：阶段 A 把所有合法候选都返回给 UI 选地址。 */
export interface SuggestPoiPlacesResult {
  httpStatus: number;
  businessStatus: string;
  places: SuggestPoiParsedPoi[];
}

export interface SearchImageParsedItem {
  imageId: number;
}

export interface SearchImageResponse {
  httpStatus: number;
  businessStatus: string;
  imageIds: number[];
}

/** 纯函数：构造 suggestpoi.json 请求体，keyword 留空时抛错。 */
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

/** 纯函数：构造 searchImage 请求体；poiId 必须为正整数。
 *  payload 完全按用户提供的真实请求体固化：District / PoiId / Country 三个 tag
 *  （District / Country 留空）；sources [1, 9]；urlOptions 200 / 500 两档
 *  R 类型；imageClass TourProduct；pageIndex 1；pageSize 默认 20；
 *  auditStatuses [4]；excludeGif true。 */
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

/** 解析 suggestpoi.json 响应：取第一个具备 poiId + poiName 的候选。
 *  - 仅供旧 single-stage 兼容链路使用；新两阶段链路请用 parseSuggestPoiPlaces。 */
export function parseSuggestPoiPayload(payload: unknown, httpStatus = 200): SuggestPoiResponse {
  const root = asRecord(payload);
  const responseStatus = asRecord(root?.ResponseStatus);
  const ack = responseStatus?.Ack;
  if (!isBusinessSuccess(ack)) {
    throw new Error(`suggestPoi 业务失败：${failureReason(responseStatus)}`);
  }
  // 兼容 suggestpoi 的历史与当前响应形态。
  const list = pickPoiList(root);
  for (const entry of list) {
    const poi = asRecord(entry);
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

/**
 * 解析 suggestpoi.json 响应为「地址 / 景点候选列表」：
 *  - Ack 非 Success 直接抛错；
 *  - body / poiList / poiDtos / data.* 等多种形态都尝试；
 *  - 每条 entry 至少需要 poiId + poiName 才算合法；缺任一字段即跳过；
 *  - 可选 address / province / city / district 等字段按字符串 trim 抽取，
 *    缺或非字符串 → null；
 *  - 返回所有合法候选；空列表不算错，UI 走"无结果"分支。
 *  - 按 suggestPoi 原始顺序排列；相同 poiId 仅保留首个（dedup by poiId）。
 */
export function parseSuggestPoiPlaces(payload: unknown, httpStatus = 200): SuggestPoiPlacesResult {
  const root = asRecord(payload);
  const responseStatus = asRecord(root?.ResponseStatus);
  const ack = responseStatus?.Ack;
  if (!isBusinessSuccess(ack)) {
    throw new Error(`suggestPoi 业务失败：${failureReason(responseStatus)}`);
  }
  const list = pickPoiList(root);
  const places: SuggestPoiParsedPoi[] = [];
  const seen = new Set<number>();
  for (const entry of list) {
    const poi = asRecord(entry);
    if (!poi) continue;
    const parsed = parsePoiFromEntry(poi);
    if (!parsed) continue;
    if (seen.has(parsed.poiId)) continue;
    seen.add(parsed.poiId);
    places.push(parsed);
  }
  return { httpStatus, businessStatus: String(ack ?? "Success"), places };
}

/**
 * 解析 searchImage 响应，提取 imageId 列表：
 *   - body / imageIds / images / data.imageIds / data.images 等多种形态都尝试；
 *   - 每条记录用 imageId / id / picId / pic_id 等字段识别正整数。
 *   - Ack 非 Success 直接抛错；body 为空 → 返回空数组（不抛错，UI 走"无候选"分支）。
 */
export function parseSearchImagePayload(payload: unknown, httpStatus = 200): SearchImageResponse {
  const root = asRecord(payload);
  const responseStatus = asRecord(root?.ResponseStatus);
  const ack = responseStatus?.Ack;
  if (!isBusinessSuccess(ack)) {
    throw new Error(`searchImage 业务失败：${failureReason(responseStatus)}`);
  }
  const list = pickImageList(root);
  const seen = new Set<number>();
  const imageIds: number[] = [];
  for (const entry of list) {
    const id = readImageId(entry);
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

/**
 * 把 suggestPoi 单条 entry 解析为带可选字段的 POI。
 *  - 必填：poiId 正整数 + 名称非空（poiName 优先，name 兜底）；
 *  - 选填：address / province / city / district / areaName 等常见 key；
 *  - 解析失败（缺必填）返回 null，由调用方决定是否丢弃；
 *  - 与 parseSuggestPoiPayload / parseSuggestPoiPlaces 共享字段名归一。
 */
export function parsePoiFromEntry(poi: Record<string, unknown>): SuggestPoiParsedPoi | null {
  const poiId = positiveInteger(poi.poiId);
  const rawName = optionalString(poi.poiName) ?? optionalString(poi.name) ?? "";
  if (poiId === null || !rawName) return null;
  return {
    poiId,
    poiName: rawName,
    address: optionalString(poi.address ?? poi.addr),
    province: optionalString(poi.provinceName ?? poi.province ?? poi.province_name),
    city: optionalString(poi.cityName ?? poi.city ?? poi.city_name),
    district: optionalString(poi.districtName ?? poi.district ?? poi.district_name ?? poi.areaName),
  };
}

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function emptyHead(): CtripLibraryRequestHead {
  return {
    cid: "",
    ctok: "",
    cver: "1.0",
    lang: "01",
    sid: "8888",
    syscode: "09",
    auth: "",
    xsid: "",
    extension: [],
  };
}

export const EMPTY_CTRIP_SESSION_CONTEXT: CoverPlaceSearchSessionContext = EMPTY_COVER_PLACE_SEARCH_CONTEXT;

export function clampPageSize(value: number): number {
  if (!Number.isInteger(value) || value <= 0) return 20;
  return Math.min(value, SEARCH_IMAGE_MAX_PAGE_SIZE);
}

function pickPoiList(root: Record<string, unknown> | null): unknown[] {
  if (!root) return [];
  if (Array.isArray(root.body)) return root.body;
  if (Array.isArray(root.poiList)) return root.poiList;
  if (Array.isArray(root.poiDtos)) return root.poiDtos;
  const data = asRecord(root.data);
  if (data && Array.isArray(data.poiList)) return data.poiList;
  if (data && Array.isArray(data.poiDtos)) return data.poiDtos;
  if (data && Array.isArray(data.body)) return data.body;
  return [];
}

function pickImageList(root: Record<string, unknown> | null): unknown[] {
  if (!root) return [];
  if (Array.isArray(root.imageIds)) return root.imageIds;
  if (Array.isArray(root.imageList)) return root.imageList;
  if (Array.isArray(root.images)) return root.images;
  if (Array.isArray(root.body)) return root.body;
  const data = asRecord(root.data);
  if (!data) return [];
  if (Array.isArray(data.imageIds)) return data.imageIds;
  if (Array.isArray(data.imageList)) return data.imageList;
  if (Array.isArray(data.images)) return data.images;
  if (Array.isArray(data.body)) return data.body;
  return [];
}

function readImageId(entry: unknown): number | null {
  const record = asRecord(entry);
  if (!record) {
    if (typeof entry === "number") return positiveInteger(entry);
    if (typeof entry === "string") return positiveInteger(entry);
    return null;
  }
  const id = positiveInteger(record.imageId)
    ?? positiveInteger(record.id)
    ?? positiveInteger(record.picId)
    ?? positiveInteger(record.pic_id)
    ?? positiveInteger(record.imageID);
  if (id !== null) return id;
  // 兜底：可能是 { image: { imageId: ... } }
  const nested = asRecord(record.image);
  if (nested) {
    return positiveInteger(nested.imageId)
      ?? positiveInteger(nested.id)
      ?? positiveInteger(nested.picId);
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isBusinessSuccess(ack: unknown): boolean {
  return ack === "Success" || ack === "SUCCESS" || ack === true || ack === "true";
}

export function positiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

export function failureReason(status: Record<string, unknown> | null): string {
  const errors = Array.isArray(status?.Errors) ? status?.Errors : [];
  const first = asRecord(errors[0]);
  const reason = first?.Message ?? first?.message ?? first?.Code ?? status?.Ack ?? "ResponseStatus 未确认成功";
  return String(reason).replace(/[\r\n\t]/g, " ").slice(0, 300);
}

export function timeoutOrDefault(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : fallback;
}
