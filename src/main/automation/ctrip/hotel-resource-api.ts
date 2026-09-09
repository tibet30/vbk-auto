import { hotelDiamondFromTier } from "../../../shared/hotel-tiers.js";
import { HOTEL_RESOURCE_CANDIDATE_COUNT, HOTEL_RESOURCE_MIN_CANDIDATE_COUNT } from "../../../shared/hotel-candidate-counts.js";
import { hasItineraryHotelStay } from "../../../shared/itinerary-hotel.js";
import { requiresVehicleResource } from "../../../shared/product-form.js";
import {
  buildLodgingResourceSegment,
  ensureResourceSegmentsDraftApi,
  getProductSegmentsApi,
  initializeResourceSegmentsDraftApi,
  resolveResourceSegmentCityApi,
  saveProductSegmentApi,
  segmentsFromPayload,
  submitResourceSegmentsApi,
} from "./vehicle-resource-api.js";
import { hotelIdsFromSegment, syncCtripHotelResources } from "./hotel-resource-page.js";

/**
 * 全程段承载套餐和用车；正住宿段承载指定酒店。携程来源会在每个住宿段保存
 * 最多五家候选，并以接口回读作为验收；携程只返回一家时也允许继续。
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
      || new Set(day.hotelCandidates.map((candidate: any) => Number(candidate.hotelId))).size !== day.hotelCandidates.length
      || day.hotelCandidates.some((candidate: any) => Number(candidate.hotelId) <= 0));
    if (missingCandidates.length) {
      throw new Error(`酒店资源缺少每晚至少 ${HOTEL_RESOURCE_MIN_CANDIDATE_COUNT} 个且最多 ${HOTEL_RESOURCE_CANDIDATE_COUNT} 个携程候选：第 ${missingCandidates.map((day: any) => day.day).join("、")} 天`);
    }
  }

  let payload = await ensureResourceSegmentsDraftApi(page, productId);
  const layout = await normalizeHotelResourceLayout({ page, productId, resolvedDays, payload });
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
      if (hasAnyRequestedHotel(afterFailure, resourceSegments)) {
        throw new Error("VBK 指定酒店资源保存结果不确定：回读发现已有酒店绑定，已停止自动重试以避免覆盖部分保存。");
      }
      await initializeResourceSegmentsDraftApi(page, productId);
      return ensureHotelResourceApi(page, product, productId, { draftRepairAttempted: true });
    }
    // Private-tour vehicleResource later submits the same resource draft.
    // Group/free-travel products skip that phase, so hotel must produce
    // formal productSegments evidence itself after rooms are in the draft.
    if (product.sales?.productForm && !requiresVehicleResource(product.sales.productForm)) {
      await settleHotelResourceDraft({ page, productId, resourceSegments });
    }
  }
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

/** A non-empty readback means the rejected save might have partially landed; never replay it. */
function hasAnyRequestedHotel(payload: any, dailyCandidates: Array<{ segmentId: string; candidates: Array<{ hotelId: number }> }>) {
  const requested = new Set(dailyCandidates.flatMap((day) => day.candidates.map((candidate) => Number(candidate.hotelId))));
  return segmentsFromPayload(payload).some((segment) => {
    const rooms = Array.isArray(segment?.hotel?.segmentRooms) ? segment.hotel.segmentRooms : [];
    return rooms.some((room: any) => requested.has(Number(room?.masterHotelID ?? room?.hotelID)));
  });
}

/** "无" 是明确的不住宿意图，不能被当作一个可配置酒店。 */
function hasPlannedHotel(day: any) {
  return hasItineraryHotelStay(day?.hotel);
}

/**
 * 资源配置的首段是全程随团段，只承载套餐和用车；住宿必须从第二段开始按连续住宿城市拆分。
 * 平台新建产品只有“全程段 + 末尾空段”时，自动在末尾空段之前创建连续住宿城市段；
 * 每一段的停留范围与住宿晚数必须相等。全程段不承载住宿，两个值均归零并清空指定酒店。
 */
async function normalizeHotelResourceLayout(args: {
  page: any;
  productId: string;
  resolvedDays: any[];
  payload: any;
}) {
  const expected = hotelStayGroups(args.resolvedDays);
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
    await submitResourceSegmentsApi(args.page, args.productId);
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
  if (created || corrections.length) await submitResourceSegmentsApi(args.page, args.productId);
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

/**
 * saveSegment 只写草稿。非私家团没有后续 submitSegments，必须在酒店名单
 * 已在草稿中之后提交一次，并以正式段回读作为验收。
 */
async function settleHotelResourceDraft(args: {
  page: any;
  productId: string;
  resourceSegments: Array<{ day: number; segmentId: string; candidates: Array<{ hotelId: number }> }>;
}) {
  const draftPayload = await getProductSegmentsApi(args.page, args.productId);
  assertHotelSegmentsMatch(segmentsFromPayload(draftPayload), args.resourceSegments, "草稿");
  if (hotelSegmentsMatch(segmentsFromPayload(draftPayload, { formalOnly: true }), args.resourceSegments)) {
    return;
  }
  await submitResourceSegmentsApi(args.page, args.productId);
  const formalPayload = await getProductSegmentsApi(args.page, args.productId);
  assertHotelSegmentsMatch(
    segmentsFromPayload(formalPayload, { formalOnly: true }),
    args.resourceSegments,
    "正式",
  );
}

function hotelSegmentsMatch(
  segments: any[],
  resourceSegments: Array<{ segmentId: string; candidates: Array<{ hotelId: number }> }>,
): boolean {
  return resourceSegments.every((daily) => {
    const expected = daily.candidates.map((candidate) => Number(candidate.hotelId));
    const segment = segments.find((item) => String(item.segmentId) === daily.segmentId);
    return sameHotelIds(hotelIdsFromSegment(segment), expected);
  });
}

function assertHotelSegmentsMatch(
  segments: any[],
  resourceSegments: Array<{ segmentId: string; candidates: Array<{ hotelId: number }> }>,
  label: string,
) {
  for (const daily of resourceSegments) {
    const expected = daily.candidates.map((candidate) => Number(candidate.hotelId));
    const segment = segments.find((item) => String(item.segmentId) === daily.segmentId);
    const actual = hotelIdsFromSegment(segment);
    if (!sameHotelIds(actual, expected)) {
      throw new Error(`酒店资源${label}段回读不一致：行程段 ${daily.segmentId} 期望 ${expected.join("、")}，实际 ${actual.join("、") || "无"}`);
    }
  }
}

function sameHotelIds(actual: number[], expected: number[]) {
  return actual.length === expected.length
    && new Set(actual).size === actual.length
    && actual.every((id) => expected.includes(id));
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
    throw new Error(`住宿资源行程段未按连续住宿城市拆分：期望 ${expected.map((group) => `${group.cityName}${group.nights}晚`).join("、")}`);
  }
}

export function hotelStayGroups(resolvedDays: any[]) {
  const groups: Array<{ cityName: string; nights: number }> = [];
  for (const day of resolvedDays) {
    const cityName = String(day.hotelCandidates?.[0]?.cityName ?? "").trim();
    if (!cityName) throw new Error(`第 ${day.day} 天酒店候选缺少城市`);
    const previous = groups.at(-1);
    if (previous?.cityName === cityName) previous.nights += 1;
    else groups.push({ cityName, nights: 1 });
  }
  return groups;
}

/**
 * VBK 可能将连续住宿日合并为一个资源行程段。每段最多配置五家酒店，
 * 因此以该段首晚的候选为资源候选；每日行程仍保留各自的前三家备选，
 * 不能因为不同游览锚点产生了额外备选就阻断整条录入链路。
 */
export function ctripResourceSegments(resolvedDays: any[], lodging: any[]) {
  let offset = 0;
  const entries = lodging.map((segment: any) => {
    const nightCount = Math.max(1, Number(segment.segmentBase?.stayNights) || 0);
    const days = resolvedDays.slice(offset, offset + nightCount);
    offset += nightCount;
    const first = days[0];
    if (!first) throw new Error(`住宿行程段 ${String(segment.segmentId)} 未匹配到住宿日`);
    const candidates = first.hotelCandidates as Array<{ hotelId: number; hotelName: string }>;
    return { day: Number(first.day), segmentId: String(segment.segmentId), candidates };
  });
  if (offset !== resolvedDays.length) {
    throw new Error(`住宿日无法按携程资源行程段映射：${resolvedDays.length} 天 / ${lodging.length} 段`);
  }
  return entries;
}
