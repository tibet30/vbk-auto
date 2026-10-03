import { HOTEL_RESOURCE_CANDIDATE_COUNT, HOTEL_RESOURCE_MIN_CANDIDATE_COUNT } from "../../../shared/hotel-candidate-counts.js";
import {
  getProductSegmentsApi,
  initializeResourceSegmentsDraftApi,
  saveProductSegmentApi,
  segmentsFromPayload,
} from "./vehicle-resource-api.js";
import { unchangedResourceSegments } from "./resource-segment-readback.js";

type Candidate = { hotelId: number; hotelName: string };
type ResourceSegment = { day: number; segmentId: string; candidates: Candidate[] };

/**
 * 使用资源编辑器同一套 /15638/saveSegment 协议录入“指定酒店”。
 *
 * 不能以页面弹窗中的查询表或 toast 作为保存依据：它们都不表示产品草稿已落库。
 * 这里每次先从 getSegments 取得完整行程段，覆盖 hotel.segmentRooms 后保存，再以
 * getSegments 回读精确确认该段保存的酒店集合。资源编辑器保存指定酒店时仅调用
 * saveSegment；不能为酒店名单额外 submitSegments，否则后端会重新结算草稿并可能
 * 覆盖刚保存的指定酒店。
 */
export async function syncCtripHotelResources(args: {
  page: any;
  productId: string;
  dailyCandidates: ResourceSegment[];
}) {
  const { page, productId, dailyCandidates } = args;
  let payload = await getProductSegmentsApi(page, productId);
  let resolvedCandidates = dailyCandidates;
  if (dailyCandidates.some((daily) => !findSegment(payload, daily.segmentId))) {
    resolvedCandidates = remapCandidatesToCurrentLodgingSegments(payload, dailyCandidates);
  }
  const originalSegments = segmentsFromPayload(payload);
  const slots = resolvedCandidates.map((daily) => originalSegments.findIndex((segment: any) => String(segment.segmentId) === daily.segmentId));
  const slotKeys = originalSegments.map(lodgingSlotKey);
  const remapSlots = () => {
    const currentSegments = segmentsFromPayload(payload);
    if (currentSegments.length !== originalSegments.length
      || currentSegments.some((item: any, slot: number) => lodgingSlotKey(item) !== slotKeys[slot])) {
      throw new Error("酒店资源保存后住宿段结构发生变化，停止继续绑定酒店");
    }
    resolvedCandidates = resolvedCandidates.map((item, position) => ({
      ...item, segmentId: String(currentSegments[slots[position]!]!.segmentId),
    }));
    for (let position = 0; position < days.length; position += 1) {
      days[position]!.segmentId = resolvedCandidates[position]!.segmentId;
    }
  };
  const restoreDraft = async () => {
    const restored = await initializeResourceSegmentsDraftApi(page, productId);
    if (!unchangedResourceSegments(payload, restored)) {
      throw new Error("VBK 资源草稿恢复后内容发生变化，停止酒店写入并保留已保存内容");
    }
    payload = restored;
    remapSlots();
  };
  let changed = false;
  const days: Array<{ day: number; segmentId: string; resourceHotelIds: number[]; addedHotelIds: number[] }> = [];

  for (let index = 0; index < resolvedCandidates.length; index += 1) {
    const daily = resolvedCandidates[index]!;
    const ids = candidateIds(daily);
    let segment = findSegment(payload, daily.segmentId);
    if (!segment) throw new Error(`酒店资源接口回读未找到行程段：${daily.segmentId}`);

    const before = hotelIdsFromSegment(segment);
    if (!sameHotelSet(before, ids) || !hasDesiredCandidateOrder(segment, daily.candidates)) {
      // saveSegment 可能提交当前草稿。每一段都独立检查可写草稿，恢复时以
      // 上一次权威回读为基线，不能把本轮前面已保存的酒店误判为外部变化。
      if (!Array.isArray(asRecord(payload)?.draftProductSegments?.segments)) await restoreDraft();
      const save = async () => {
        segment = findSegment(payload, resolvedCandidates[index]!.segmentId);
        if (!segment) throw new Error("酒店资源草稿恢复后未找到目标住宿段");
        await saveProductSegmentApi(page, {
          ...segment,
          hotel: {
            ...(asRecord(segment.hotel) ?? {}),
            segmentRooms: daily.candidates.map((candidate, index, all) => hotelRoom(candidate, index, all.length)),
          },
        }, "VBK 指定酒店资源保存");
      };
      try {
        await save();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/20016116|产品还没有创建草稿/.test(message)) throw error;
        const afterFailure = await getProductSegmentsApi(page, productId);
        if (!unchangedResourceSegments(payload, afterFailure)) {
          throw new Error("VBK 指定酒店资源保存结果不确定：本次保存前后资源内容发生变化，停止重试并保留已保存内容");
        }
        payload = afterFailure;
        await restoreDraft();
        await save();
      }
      changed = true;
      // saveSegment can renumber the whole draft and reuse an earlier ID.
      // Refresh every slot before the next write, even when that old ID exists.
      payload = await getProductSegmentsApi(page, productId);
      remapSlots();
    }
    days.push({
      day: daily.day,
      segmentId: resolvedCandidates[index]!.segmentId,
      resourceHotelIds: ids,
      addedHotelIds: ids.filter((id) => !before.includes(id)),
    });
  }
  if (!changed) payload = await getProductSegmentsApi(page, productId);
  for (const daily of resolvedCandidates) {
    const expected = candidateIds(daily);
    const actual = hotelIdsFromSegment(findSegment(payload, daily.segmentId));
    if (!sameHotelSet(actual, expected) || !hasDesiredCandidateOrder(findSegment(payload, daily.segmentId), daily.candidates)) {
      throw new Error(`酒店资源最终接口回读不一致：行程段 ${daily.segmentId} 期望 ${expected.join("、")}，实际 ${actual.join("、") || "无"}`);
    }
  }
  return { days, verified: true, via: changed ? "saveSegment-api" : "getSegments-api" };
}

function lodgingSlotKey(segment: any): string {
  const base = segment?.segmentBase ?? {};
  return JSON.stringify([base.stayNights, base.segmentNumber, base.destinationCity]);
}

function candidateIds(daily: ResourceSegment) {
  const ids = daily.candidates.map((candidate) => Number(candidate.hotelId));
  if (!daily.segmentId || ids.length < HOTEL_RESOURCE_MIN_CANDIDATE_COUNT || ids.length > HOTEL_RESOURCE_CANDIDATE_COUNT
    || new Set(ids).size !== ids.length
    || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error(`第 ${daily.day} 天酒店资源录入必须有行程段和 ${HOTEL_RESOURCE_MIN_CANDIDATE_COUNT}-${HOTEL_RESOURCE_CANDIDATE_COUNT} 家不同的携程酒店`);
  }
  return ids;
}

function findSegment(payload: any, segmentId: string) {
  return segmentsFromPayload(payload).find((segment: any) => String(segment.segmentId) === String(segmentId));
}

function remapCandidatesToCurrentLodgingSegments(payload: any, dailyCandidates: ResourceSegment[]) {
  const lodging = segmentsFromPayload(payload).filter((segment: any) => Number(segment?.segmentBase?.stayNights) > 0);
  if (lodging.length !== dailyCandidates.length) {
    const missing = dailyCandidates
      .filter((daily) => !findSegment(payload, daily.segmentId))
      .map((daily) => daily.segmentId);
    throw new Error(`酒店资源接口回读未找到行程段：${missing.join("、") || "无"}`);
  }
  return dailyCandidates.map((daily, index) => ({
    ...daily,
    segmentId: String(lodging[index]!.segmentId),
  }));
}

function hotelRoom(candidate: Candidate, index: number, total: number) {
  return {
    hotelName: candidate.hotelName,
    masterHotelID: Number(candidate.hotelId),
    isMasterHotel: "T",
    // VBK 按排序分从大到小展示指定酒店。因此候选数组的第一个（钻级最高、同钻最近）
    // 必须持有最大的排序分，才能与每日行程中的候选顺序保持一致。
    squenceNumber: total - index,
  };
}

/** getSegments 的已保存酒店由 segment.hotel.segmentRooms 返回。 */
export function hotelIdsFromSegment(segment: any): number[] {
  const rooms = asRecord(segment?.hotel)?.segmentRooms;
  if (!Array.isArray(rooms)) return [];
  return rooms.map((room) => Number(room?.masterHotelID ?? room?.hotelID))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
}

/** 资源服务返回的数组顺序不稳定，酒店集合的持久化校验应仅比较 ID 集合。 */
function sameHotelSet(actual: number[], expected: number[]) {
  return actual.length === expected.length
    && new Set(actual).size === actual.length
    && actual.every((id) => expected.includes(id));
}

/** 同一批 ID 也必须保留“钻级降序、同钻距离升序”的候选展示顺序。 */
function hasDesiredCandidateOrder(segment: any, candidates: Candidate[]) {
  const rooms = asRecord(segment?.hotel)?.segmentRooms;
  if (!Array.isArray(rooms) || rooms.length !== candidates.length) return false;
  const sequenceByHotelId = new Map(rooms.map((room: any) => [
    Number(room?.masterHotelID ?? room?.hotelID),
    Number(room?.squenceNumber),
  ]));
  return candidates.every((candidate, index) => sequenceByHotelId.get(Number(candidate.hotelId)) === candidates.length - index);
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
}
