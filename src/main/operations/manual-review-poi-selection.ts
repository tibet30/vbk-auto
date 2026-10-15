import type { ManualReviewFieldInput, PoiSuggestDetailResult } from "../../shared/contracts.js";
import { isManualPoiCandidateInVerifiedRouteContext } from "../planning/poi-auto-selection.js";
import type { VerifiedPoiMapping } from "../planning/types.js";

type Json = Record<string, unknown>;
type PoiInput = Extract<ManualReviewFieldInput, { field: "itinerarySpotPoi" }>;

function record(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

function selectionContext(product: Json, dayIndex: number, spotIndex: number) {
  if (!Number.isInteger(dayIndex) || dayIndex < 0 || !Number.isInteger(spotIndex) || spotIndex < 0) {
    throw new Error("行程 POI 目标索引不合法。");
  }
  const itinerary = Array.isArray(product.itinerary) ? product.itinerary : [];
  const day = record(itinerary[dayIndex]);
  const spots = Array.isArray(day.spots) ? day.spots : [];
  const spot = record(spots[spotIndex]);
  const spotName = typeof spot.name === "string" ? spot.name.trim() : "";
  if (!spotName) throw new Error("目标行程景点不存在或缺少原始名称。");
  const basic = record(product.basicInfo);
  return {
    spotName,
    context: {
      destinationCity: typeof basic.destinationCity === "string" ? basic.destinationCity.trim() : undefined,
      province: typeof basic.province === "string" ? basic.province.trim() : undefined,
    },
  };
}

/**
 * 保留全部携程候选用于人工比对，只有地域证据成立的候选可选。
 * 地域证据 = 自动路径判定，或同日已核验邻接景点证实的同省同城（见
 * isManualPoiCandidateInVerifiedRouteContext），后者专供人工兜底。
 */
export function screenManualPoiCandidates(
  product: Json,
  dayIndex: number,
  spotIndex: number,
  detail: PoiSuggestDetailResult,
): PoiSuggestDetailResult {
  const { spotName, context } = selectionContext(product, dayIndex, spotIndex);
  const selectableIds = new Set(detail.candidates.filter((candidate): candidate is typeof candidate & { poiId: number } =>
    candidate.poiId !== null
      && isManualPoiCandidateInVerifiedRouteContext(candidate, context, product, spotName, detail.candidates))
    .map(candidate => candidate.poiId));
  const candidates = detail.candidates.map(candidate => ({
    ...candidate,
    selectable: candidate.poiId !== null && candidate.selectable && selectableIds.has(candidate.poiId),
  }));
  const best = detail.best && detail.best.poiId !== null && selectableIds.has(detail.best.poiId)
    ? detail.best
    : null;
  return { ...detail, best, candidates };
}

/** Rebuilds the write payload from the current provider response, never renderer location fields. */
export function verifyManualPoiSelection(
  product: Json,
  input: PoiInput,
  detail: PoiSuggestDetailResult,
): PoiInput {
  const screened = screenManualPoiCandidates(product, input.dayIndex, input.spotIndex, detail);
  const candidate = screened.candidates.find(item => item.poiId === input.poiId && item.selectable && item.poiName?.trim());
  if (!candidate?.poiName || !candidate.poiId) {
    const { spotName } = selectionContext(product, input.dayIndex, input.spotIndex);
    throw new Error(`POI「${input.poiName.trim()}」与原行程景点「${spotName}」的地域约束不匹配，不能保存。`);
  }
  return {
    field: "itinerarySpotPoi",
    dayIndex: input.dayIndex,
    spotIndex: input.spotIndex,
    poiName: candidate.poiName.trim(),
    poiId: candidate.poiId,
    province: candidate.province?.trim() || null,
    city: candidate.city?.trim() || null,
    district: candidate.district?.trim() || null,
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * 运营在行程里按受控候选显式选定 POI 后，从**落库后的产品**取证，产出可结清
 * 「请手动选择 / 手动绑定 POI」这类决策门 task 的受控凭证。
 *
 * 取证纪律：
 *  - 只读持久化后的 product，不采信 renderer 回传的 POI 名称或地域字段；
 *  - 必须与本次写入的 POI 一致，避免并发写入（AI patch / 资源回填）在搜索与
 *    保存之间改动同一 spot 时，借用别人的绑定结清人工决策；
 *  - 任一项不成立就返回 null：宁可不结清，也不能凭空确认。
 *
 * 自动确认谓词（isResearchTaskSatisfiedByProduct）仍刻意不把「同名 + 正整数
 * POI ID」当作结清依据；本凭证是与之并列的显式人工决策证据。
 */
export function verifiedMappingForManualPoi(product: Json, input: PoiInput): VerifiedPoiMapping | null {
  const itinerary = Array.isArray(product.itinerary) ? product.itinerary : [];
  const day = record(itinerary[input.dayIndex]);
  const dayNumber = Number(day.day);
  const spots = Array.isArray(day.spots) ? day.spots : [];
  const spot = record(spots[input.spotIndex]);
  const spotName = text(spot.name);
  const poiName = text(spot.poiName);
  const poiId = spot.poiId;
  if (!spotName || !poiName || !positiveInteger(poiId) || !Number.isInteger(dayNumber) || dayNumber <= 0) return null;
  if (poiId !== input.poiId || poiName !== input.poiName.trim()) return null;
  return { day: dayNumber, spotName, poiName, poiId };
}
