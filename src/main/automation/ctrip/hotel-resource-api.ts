import { ensurePlatformHotelRulesApi } from "./hotel-rule-api.js";
import { platformHotelStayGroups } from "../../../shared/platform-hotel-rules.js";
import { toPlatformShortLocationName } from "../../../shared/location-short-name.js";
import { toVbkCityName } from "../../../shared/region-overrides.js";
import { HOTEL_RESOURCE_CANDIDATE_COUNT, HOTEL_RESOURCE_MIN_CANDIDATE_COUNT } from "../../../shared/hotel-candidate-counts.js";
import { buildLodgingResourceSegment, getProductSegmentsApi, resolveResourceSegmentCityApi, saveProductSegmentApi, segmentsFromPayload } from "./vehicle-resource-api.js";

/** Save platform automatic matching rules, then read them back before completion. */
export async function ensureHotelResourceApi(
  page: any,
  product: any,
  productId: string,
  options: { draftRepairAttempted?: boolean } = {},
) {
  return ensurePlatformHotelRulesApi(page, product, productId);
}

/** Keep the full-trip package/vehicle segment separate from lodging rules. */
export async function normalizeHotelResourceLayout(args: {
  page: any;
  productId: string;
  resolvedDays: any[];
  payload: any;
  source: "ctrip" | "package-api" | "rules";
  province?: string;
  provinceForCity?: (cityName: string, dayNumbers?: number[]) => string | undefined;
}) {
  // 平台酒店规则的住宿城市按 VBK 可写城市回读：万州等直辖市下辖区县落到重庆。
  const expected = args.source === "rules"
    ? platformHotelStayGroups({ itinerary: args.resolvedDays }).map(({ cityName, nights, dayNumbers }) => ({ cityName: toVbkCityName(cityName), nights, dayNumbers }))
    : hotelStayGroups(args.resolvedDays, args.source === "ctrip").map(group => ({ ...group, dayNumbers: undefined as number[] | undefined }));
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
        hotel: { segmentRooms: [] },
      }, "VBK 清理无住宿日的错误资源段");
    }
    payload = await getProductSegmentsApi(args.page, args.productId);
    segments = segmentsFromPayload(payload);
    existingLodging = lodgingSegments(segments);
  }
  if (args.source === "rules") {
    for (let index = 0; index < existingLodging.length; index++) {
      const segment = existingLodging[index];
      const group = expected[index]!;
      const province = args.provinceForCity?.(group.cityName, group.dayNumbers) ?? args.province;
      const destination = segment.segmentBase?.destinationCity;
      const country = fullTrip.segmentBase?.destinationCity?.countryName;
      const sameCity = toPlatformShortLocationName(destination?.cityName) === toPlatformShortLocationName(group.cityName)
        && (!province || toPlatformShortLocationName(destination?.provinceName) === toPlatformShortLocationName(province))
        && (!country || destination?.countryName === country);
      if (Number(segment.segmentBase?.stayNights) === group.nights && sameCity) continue;
      const city = sameCity ? segment.segmentBase.destinationCity
        : await resolveResourceSegmentCityApi(args.page, group.cityName, {
          province, countryName: country,
        });
      await saveProductSegmentApi(args.page, { ...segment, segmentBase: { ...segment.segmentBase, destinationCity: city,
        stayNights: group.nights, minStayNights: group.nights, maxStayNights: group.nights } }, "VBK 酒店规则住宿段转换");
      payload = await getProductSegmentsApi(args.page, args.productId);
      segments = segmentsFromPayload(payload);
      existingLodging = lodgingSegments(segments);
    }
  }
  assertLodgingPrefix(existingLodging, expected);

  let created = 0;
  while (lodgingSegments(segments).length < expected.length) {
    const currentLodging = lodgingSegments(segments);
    const group = expected[currentLodging.length]!;
    if (!usableTerminal(segments.at(-1))) {
      segments = await ensureTerminalSegment(args.page, args.productId, segments);
    }
    const terminal = segments.at(-1)!; // usableTerminal 已确认存在
    const previous = currentLodging.at(-1) ?? fullTrip;
    const departureCity = previous.segmentBase?.destinationCity;
    if (!departureCity || typeof departureCity !== "object") {
      throw new Error("VBK 资源配置全程段缺少到达城市，无法新增住宿段");
    }
    const destinationCity = await resolveResourceSegmentCityApi(args.page, group.cityName, {
      countryName: departureCity.countryName,
      province: args.provinceForCity?.(group.cityName, group.dayNumbers) ?? args.province,
    });
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
    const needsHotelCleanup = targetNights === 0 && (Boolean(segment.hotel?.systemHotel) || Array.isArray(rooms) && rooms.length > 0);
    if (!needsNightCorrection && !needsHotelCleanup) return [];
    return [{
      ...segment,
      segmentBase: { ...base, stayNights: targetNights, minStayNights: targetNights, maxStayNights: targetNights },
      ...(isFullTrip || needsHotelCleanup ? { hotel: { segmentRooms: [] } } : {}),
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
  return { changed: Boolean(created || corrections.length), created, expected: expected.map(({ cityName, nights }) => ({ cityName, nights })) };
}

function usableTerminal(segment: any): boolean {
  return Boolean(segment) && Number(segment.segmentBase?.stayNights) === 0 && segment.segmentBase?.deleteable === true;
}

/**
 * 平台偶尔不返回 0 晚可删除的末尾段。以现有末尾段为模板补建一个空段（新增协议与
 * 住宿段相同：segmentId 0），不带资源组和房间；保存后回读，仍不可用就停止。
 */
async function ensureTerminalSegment(page: any, productId: string, segments: any[]) {
  const template = segments.at(-1);
  if (!template) throw new Error(TERMINAL_REPAIR_FAILED);
  const segmentNumber = Math.max(...segments.map((segment: any) => Number(segment.segmentBase?.segmentNumber) || 0)) + 1;
  const draft = structuredClone(template);
  // 模板可能是全程段：套餐与酒店日也不能被复制到新空段。
  if (Array.isArray(draft.packages)) draft.packages = [];
  if (Array.isArray(draft.hotelDays)) draft.hotelDays = [];
  await saveProductSegmentApi(page, { ...draft, segmentId: 0, segmentResourceGroups: [], hotel: { segmentRooms: [] },
    segmentBase: { ...(draft.segmentBase ?? {}), segmentNumber, stayNights: 0, minStayNights: 0, maxStayNights: 0, deleteable: true },
  }, "VBK 补建末尾空行程段");
  const refreshed = segmentsFromPayload(await getProductSegmentsApi(page, productId));
  if (!usableTerminal(refreshed.at(-1))) throw new Error(TERMINAL_REPAIR_FAILED);
  return refreshed;
}

const TERMINAL_REPAIR_FAILED = "VBK 资源配置无法补出末尾空段，请在资源配置页手动添加一个空行程段后重试";

function lodgingSegments(segments: any[]) {
  return segments.slice(1).filter((segment: any) => Number(segment.segmentBase?.stayNights) > 0);
}

function assertLodgingPrefix(actual: any[], expected: Array<{ cityName: string; nights: number }>) {
  const mismatched = actual.some((segment, index) => {
    const group = expected[index];
    if (!group) return true;
    return Number(segment.segmentBase?.stayNights) !== group.nights
      || toPlatformShortLocationName(segment.segmentBase?.destinationCity?.cityName) !== toPlatformShortLocationName(group.cityName);
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
