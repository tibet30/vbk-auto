import { hotelDiamondFromTier } from "../../../shared/hotel-tiers.js";
import { HOTEL_RESOURCE_CANDIDATE_COUNT, HOTEL_RESOURCE_MIN_CANDIDATE_COUNT } from "../../../shared/hotel-candidate-counts.js";
import { hasItineraryHotelStay } from "../../../shared/itinerary-hotel.js";
import { productNeedsVehicleResource } from "../../../shared/product-form.js";
import {
  buildLodgingResourceSegment,
  ensureResourceSegmentsDraftApi,
  getProductSegmentsApi,
  initializeResourceSegmentsDraftApi,
  resolveResourceSegmentCityApi,
  saveProductSegmentApi,
  segmentsFromPayload,
} from "./vehicle-resource-api.js";
import { syncCtripHotelResources } from "./hotel-resource-page.js";
import { finalizeParentResourceSegments } from "./resource-segment-finalization.js";
import { unchangedResourceSegments } from "./resource-segment-readback.js";

/**
 * 全程段承载套餐和用车；正住宿段承载指定酒店。携程来源会在每个住宿段用
 * saveSegment 保存最多五家候选，并以草稿接口回读作为阶段内验收；携程只返回一家时
 * 也允许继续。无后续用车阶段时，最终统一发布资源模块并以正式段回读验收；需要用车
 * 的产品保留草稿，由用车阶段在所有资源写完后统一发布。
 */
export async function ensureHotelResourceApi(
  page: any,
  product: any,
  productId: string,
  options: { draftRepairAttempted?: boolean } = {},
) {
  const needsHotel = product.itinerary?.some(hasPlannedHotel);
  if (!needsHotel) return { skipped: "行程不含住宿", verified: true };
  const hotelTier = product.operations?.hotelTier;
  const diamond = hotelDiamondFromTier(hotelTier);
  if (!diamond) throw new Error(`酒店等级配置无效：${String(hotelTier || "未配置")}`);
  const resolvedDays = product.itinerary.filter(hasPlannedHotel);
  const hasDailyCandidates = resolvedDays.every((day: any) => Array.isArray(day.hotelCandidates)
    && day.hotelCandidates.length >= HOTEL_RESOURCE_MIN_CANDIDATE_COUNT);
  const source = product.operations?.hotelResource?.source === "ctrip" || hasDailyCandidates ? "ctrip" : "package-api";
  if (source === "ctrip") {
    const missingCandidates = resolvedDays.filter((day: any) => !Array.isArray(day.hotelCandidates)
      || day.hotelCandidates.length < HOTEL_RESOURCE_MIN_CANDIDATE_COUNT
      || day.hotelCandidates.length > HOTEL_RESOURCE_CANDIDATE_COUNT
      || !hasValidCtripCandidateIds(day.hotelCandidates));
    if (missingCandidates.length) {
      throw new Error(`酒店资源缺少每晚至少 ${HOTEL_RESOURCE_MIN_CANDIDATE_COUNT} 个且最多 ${HOTEL_RESOURCE_CANDIDATE_COUNT} 个携程候选：第 ${missingCandidates.map((day: any) => day.day).join("、")} 天`);
    }
  }

  let payload = await ensureResourceSegmentsDraftApi(page, productId);
  const layout = await normalizeHotelResourceLayout({ page, productId, resolvedDays, payload, source });
  if (layout.changed) payload = await getProductSegmentsApi(page, productId);
  const segments = segmentsFromPayload(payload);
  if (!segments.length) throw new Error("酒店资源接口回读未返回任何行程段");
  const lodging = segments.filter((segment) => Number(segment.segmentBase?.stayNights) > 0);
  if (!lodging.length) throw new Error("行程含住宿，但资源接口未返回正住宿段");
  // 套餐与全程用车属于首个全程段；住宿段只承载“指定酒店”。
  // 因此不能以正住宿段是否携带套餐作为酒店保存前提。
  const resourceSegments = source === "ctrip" ? ctripResourceSegments(resolvedDays, lodging) : [];
  let ctripResource;
  if (source === "ctrip") {
    try {
      ctripResource = await syncCtripHotelResources({ page, productId, dailyCandidates: resourceSegments });
    } catch (error) {
      if (!isMissingResourceDraft(error) || options.draftRepairAttempted) throw error;
      const afterFailure = await getProductSegmentsApi(page, productId);
      if (!unchangedResourceSegments(payload, afterFailure)) {
        throw new Error("VBK 指定酒店资源保存结果不确定：保存前后资源内容发生变化，已停止自动重试以避免覆盖部分保存。");
      }
      const repaired = await initializeResourceSegmentsDraftApi(page, productId);
      if (!unchangedResourceSegments(afterFailure, repaired)) {
        throw new Error("VBK 资源草稿恢复后内容发生变化，已停止酒店写入并保留现场。");
      }
      return ensureHotelResourceApi(page, product, productId, { draftRepairAttempted: true });
    }
  }
  const freshPayload = await getProductSegmentsApi(page, productId);
  const finalization = productNeedsVehicleResource(product)
    ? { deferred: true, reason: "等待用车资源阶段统一发布" }
    : await finalizeParentResourceSegments(page, productId, freshPayload, {});
  return {
    source,
    resourceName: source === "ctrip" ? String(resolvedDays[0]?.hotel ?? "") : undefined,
    packageManaged: true,
    verified: true,
    hotelTier,
    diamond,
    positiveSegmentCount: lodging.length,
    segmentIds: lodging.map((segment) => String(segment.segmentId)),
    layout,
    finalization,
    ...(source === "ctrip"
      ? {
        dailyCandidates: resolvedDays.map((day: any) => ({ day: Number(day.day), candidates: day.hotelCandidates })),
        ctripResource,
      }
      : {}),
  };
}

function isMissingResourceDraft(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("20016116") || message.includes("产品还没有创建草稿");
}

/** "无" 是明确的不住宿意图，不能被当作一个可配置酒店。 */
function hasPlannedHotel(day: any) {
  return hasItineraryHotelStay(day?.hotel);
}

/**
 * 资源配置的首段是全程随团段，只承载套餐和用车；携程指定酒店从第二段开始按连续同城且候选一致的晚次拆分。
 * 平台新建产品只有“全程段 + 末尾空段”时，自动在末尾空段之前创建连续住宿城市段；
 * 每一段的停留范围与住宿晚数必须相等。全程段不承载住宿，两个值均归零并清空指定酒店。
 */
async function normalizeHotelResourceLayout(args: {
  page: any;
  productId: string;
  resolvedDays: any[];
  payload: any;
  source: "ctrip" | "package-api";
}) {
  const expected = hotelStayGroups(args.resolvedDays, args.source === "ctrip");
  let payload = args.payload;
  let segments = segmentsFromPayload(payload);
  const [fullTrip] = segments;
  if (!fullTrip) throw new Error("VBK 资源配置未返回全程行程段");

  let existingLodging = lodgingSegments(segments);
  // 旧版本会把 hotel: "无" 误建成住宿段。该段没有用户酒店资源，且平台标为
  // deleteable；不删除记录，只归零住宿与房间，避免 D2 的“不住宿”被继续配置。
  const excess = existingLodging.slice(expected.length);
  if (excess.length) {
    if (excess.some((segment: any) => segment.segmentBase?.deleteable !== true)) {
      throw new Error(`住宿资源行程段超过行程住宿城市数且不可安全归零：已有 ${existingLodging.length} 段，期望 ${expected.length} 段`);
    }
    for (const segment of excess) {
      await saveProductSegmentApi(args.page, {
        ...segment,
        segmentBase: { ...segment.segmentBase, stayNights: 0, minStayNights: 0, maxStayNights: 0 },
        hotel: { ...(segment.hotel ?? {}), segmentRooms: [] },
      }, "VBK 清理无住宿日的错误资源段");
    }
    payload = await getProductSegmentsApi(args.page, args.productId);
    segments = segmentsFromPayload(payload);
    existingLodging = lodgingSegments(segments);
  }
  assertLodgingPrefix(existingLodging, expected);

  let created = 0;
  while (lodgingSegments(segments).length < expected.length) {
    const currentLodging = lodgingSegments(segments);
    const group = expected[currentLodging.length]!;
    const terminal = segments.at(-1);
    if (!terminal || Number(terminal.segmentBase?.stayNights) !== 0 || terminal.segmentBase?.deleteable !== true) {
      throw new Error("VBK 资源配置缺少可用于新增住宿段的末尾空段");
    }
    const previous = currentLodging.at(-1) ?? fullTrip;
    const departureCity = previous.segmentBase?.destinationCity;
    if (!departureCity || typeof departureCity !== "object") {
      throw new Error("VBK 资源配置全程段缺少到达城市，无法新增住宿段");
    }
    const destinationCity = await resolveResourceSegmentCityApi(args.page, group.cityName);
    const draft = buildLodgingResourceSegment({
      terminalTemplate: terminal,
      segmentNumber: Number(terminal.segmentBase?.segmentNumber),
      departureCity,
      destinationCity,
      nights: group.nights,
    });
    await saveProductSegmentApi(args.page, draft, `VBK 新增${group.cityName}住宿行程段`);
    payload = await getProductSegmentsApi(args.page, args.productId);
    segments = segmentsFromPayload(payload);
    assertLodgingPrefix(lodgingSegments(segments), expected);
    created += 1;
  }

  const corrections = segments.flatMap((segment: any, index: number) => {
    const base = segment.segmentBase ?? {};
    const nights = Number(base.stayNights);
    if (!Number.isInteger(nights) || nights < 0) {
      throw new Error(`资源行程段 ${String(segment.segmentId)} 的住宿晚数无效`);
    }
    const isFullTrip = index === 0;
    const targetNights = isFullTrip ? 0 : nights;
    const rooms = segment.hotel?.segmentRooms;
    const needsNightCorrection = nights !== targetNights
      || Number(base.minStayNights) !== targetNights
      || Number(base.maxStayNights) !== targetNights;
    const needsHotelCleanup = isFullTrip && Array.isArray(rooms) && rooms.length > 0;
    if (!needsNightCorrection && !needsHotelCleanup) return [];
    return [{
      ...segment,
      segmentBase: { ...base, stayNights: targetNights, minStayNights: targetNights, maxStayNights: targetNights },
      ...(isFullTrip ? { hotel: { ...(segment.hotel ?? {}), segmentRooms: [] } } : {}),
    }];
  });
  for (const segment of corrections) {
    await saveProductSegmentApi(args.page, segment, "VBK 资源行程段晚数修正");
  }
  const verified = segmentsFromPayload(await getProductSegmentsApi(args.page, args.productId));
  assertLodgingPrefix(lodgingSegments(verified), expected);
  const unequal = verified.filter((segment: any) => {
    const base = segment.segmentBase ?? {};
    return Number(base.stayNights) !== Number(base.minStayNights)
      || Number(base.stayNights) !== Number(base.maxStayNights);
  });
  if (unequal.length) throw new Error(`资源行程段停留晚数与住宿晚数不一致：${unequal.map((segment: any) => String(segment.segmentId)).join("、")}`);
  return { changed: Boolean(created || corrections.length), created, expected };
}

function lodgingSegments(segments: any[]) {
  return segments.slice(1).filter((segment: any) => Number(segment.segmentBase?.stayNights) > 0);
}

function assertLodgingPrefix(actual: any[], expected: Array<{ cityName: string; nights: number }>) {
  const mismatched = actual.some((segment, index) => {
    const group = expected[index];
    if (!group) return true;
    return Number(segment.segmentBase?.stayNights) !== group.nights
      || String(segment.segmentBase?.destinationCity?.cityName ?? "").trim() !== group.cityName;
  });
  if (mismatched) {
    throw new Error(`住宿资源行程段未按预期住宿晚次拆分：期望 ${expected.map((group) => `${group.cityName}${group.nights}晚`).join("、")}`);
  }
}

export function hotelStayGroups(resolvedDays: any[], requireCtripIds = false) {
  return hotelResourceGroups(resolvedDays, requireCtripIds).map(({ cityName, nights }) => ({ cityName, nights }));
}

/**
 * A resource segment can span multiple nights only when it carries the exact
 * same ordered Ctrip alternatives for each night.  A same-city stay with a
 * different hotel set still needs independent segments: saveSegment has only
 * one segmentRooms collection and would otherwise overwrite a later night.
 */
export function hotelResourceGroups(resolvedDays: any[], requireCtripIds = false) {
  const groups: Array<{ cityName: string; nights: number; dayNumbers: number[]; hotelIds: number[] }> = [];
  for (const day of resolvedDays) {
    const candidates = Array.isArray(day.hotelCandidates) ? day.hotelCandidates : [];
    const cityName = String(candidates[0]?.cityName ?? "").trim();
    if (!cityName) throw new Error(`第 ${day.day} 天酒店候选缺少城市`);
    const hotelIds = candidateIds(candidates, Number(day.day), requireCtripIds);
    const previous = groups.at(-1);
    if (previous?.cityName === cityName && sameOrderedHotelIds(previous.hotelIds, hotelIds, requireCtripIds)) {
      previous.nights += 1;
      previous.dayNumbers.push(Number(day.day));
    } else {
      groups.push({ cityName, nights: 1, dayNumbers: [Number(day.day)], hotelIds });
    }
  }
  return groups;
}

/**
 * Preserve legacy package-managed grouping when a day does not carry usable
 * Ctrip IDs.  Ctrip-backed candidates are split unless their ordered IDs are
 * fully identical, including candidate count.
 */
function sameOrderedHotelIds(left: number[], right: number[], requireCtripIds: boolean): boolean {
  // Package-managed resources do not own Ctrip hotel alternatives. Preserve
  // their historical city-only grouping regardless of incidental candidate data.
  if (!requireCtripIds) return true;
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function candidateIds(candidates: any[], day: number, requireCtripIds: boolean): number[] {
  const ids = candidates.map((candidate: any) => Number(candidate?.hotelId));
  if (requireCtripIds && !hasValidCtripIds(ids)) {
    throw new Error(`第 ${day} 天携程酒店候选 ID 无效或重复。`);
  }
  return ids;
}

function hasValidCtripCandidateIds(candidates: any[]): boolean {
  return hasValidCtripIds(candidates.map((candidate: any) => Number(candidate?.hotelId)));
}

function hasValidCtripIds(ids: number[]): boolean {
  return ids.length >= HOTEL_RESOURCE_MIN_CANDIDATE_COUNT
    && ids.length <= HOTEL_RESOURCE_CANDIDATE_COUNT
    && ids.every((id) => Number.isSafeInteger(id) && id > 0)
    && new Set(ids).size === ids.length;
}

/**
 * VBK 允许连续住宿日合并为一个资源行程段，但该段只有一个 segmentRooms
 * 集合。故只有每晚候选 ID 及顺序完全一致才可使用首晚名单；调用者若传入
 * 已合并却不同候选的晚次必须失败，不能静默丢弃后续候选。
 */
export function ctripResourceSegments(resolvedDays: any[], lodging: any[]) {
  let offset = 0;
  const entries = lodging.map((segment: any) => {
    const nightCount = Math.max(1, Number(segment.segmentBase?.stayNights) || 0);
    const days = resolvedDays.slice(offset, offset + nightCount);
    offset += nightCount;
    const first = days[0];
    if (!first) throw new Error(`住宿行程段 ${String(segment.segmentId)} 未匹配到住宿日`);
    const firstIds = candidateIds(first.hotelCandidates ?? [], Number(first.day), true);
    for (const day of days.slice(1)) {
      const ids = candidateIds(day.hotelCandidates ?? [], Number(day.day), true);
      if (!sameOrderedHotelIds(firstIds, ids, true)) {
        throw new Error(`住宿行程段 ${String(segment.segmentId)} 覆盖的第 ${Number(first.day)}、${Number(day.day)} 天携程酒店候选不一致，拒绝只保留首晚候选。`);
      }
    }
    const candidates = first.hotelCandidates as Array<{ hotelId: number; hotelName: string }>;
    return { day: Number(first.day), segmentId: String(segment.segmentId), candidates };
  });
  if (offset !== resolvedDays.length) {
    throw new Error(`住宿日无法按携程资源行程段映射：${resolvedDays.length} 天 / ${lodging.length} 段`);
  }
  return entries;
}
