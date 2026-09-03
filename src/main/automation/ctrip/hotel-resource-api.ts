import { hotelDiamondFromTier } from "../../../shared/hotel-tiers.js";
import { HOTEL_RESOURCE_CANDIDATE_COUNT, HOTEL_RESOURCE_MIN_CANDIDATE_COUNT } from "../../../shared/hotel-candidate-counts.js";
import {
  buildLodgingResourceSegment,
  ensureResourceSegmentsDraftApi,
  getProductSegmentsApi,
  resolveResourceSegmentCityApi,
  saveProductSegmentApi,
  segmentsFromPayload,
  submitResourceSegmentsApi,
} from "./vehicle-resource-api.js";
import { syncCtripHotelResources } from "./hotel-resource-page.js";

/**
 * 全程段承载套餐和用车；正住宿段承载指定酒店。携程来源会在每个住宿段保存
 * 最多五家候选，并以接口回读作为验收；携程只返回一家时也允许继续。
 */
export async function ensureHotelResourceApi(
  page: any,
  product: any,
  productId: string,
) {
  const needsHotel = product.itinerary?.some((day: any) => Boolean(day.hotel));
  if (!needsHotel) return { skipped: "行程不含住宿", verified: true };
  const hotelTier = product.operations?.hotelTier;
  const diamond = hotelDiamondFromTier(hotelTier);
  if (!diamond) throw new Error(`酒店等级配置无效：${String(hotelTier || "未配置")}`);
  const resolvedDays = product.itinerary.filter((day: any) => Boolean(day.hotel));
  if (product.operations?.hotelResource?.source === "ctrip") {
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
  const source = product.operations?.hotelResource?.source === "ctrip" ? "ctrip" : "package-api";
  const resourceSegments = source === "ctrip" ? ctripResourceSegments(resolvedDays, lodging) : [];
  const ctripResource = source === "ctrip"
    ? await syncCtripHotelResources({
      page,
      productId,
      dailyCandidates: resourceSegments,
    })
    : undefined;
  return {
    source,
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

  const existingLodging = lodgingSegments(segments);
  assertLodgingPrefix(existingLodging, expected);
  if (existingLodging.length > expected.length) {
    throw new Error(`住宿资源行程段超过行程住宿城市数：已有 ${existingLodging.length} 段，期望 ${expected.length} 段`);
  }

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
