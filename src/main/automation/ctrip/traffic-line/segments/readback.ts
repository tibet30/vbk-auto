/**
 * 子产品资源段"正式回读"工具：
 *   - readTrafficLineSegmentReadback：getSegments → productSegments，verifySegmentBoundaries
 *     + verifyValidatedDepartureCityReadback；
 *   - publishedSegmentReadbackIsComplete：用于 publishSegmentModule 超时兼容——草稿已消耗
 *     且正式资源边界完整 + 出发城市读回完整。
 *
 * 设计要点：
 *   - 已激活子产品的 getSegments 可同时返回编辑草稿和已发布资源段。最终回读
 *     只以 productSegments 的完整性为准；草稿并存不表示正式资源不存在。
 */

import type { TrafficLineEndpointPlan, TrafficLineVariant } from "../../../../../shared/contracts-traffic-line.js";
import { departureCityReadbackIsComplete, verifyValidatedDepartureCityReadback } from "../segment-departure-cities.js";
import type { JsonRecord, TrafficLinePage } from "../client.js";
import { record } from "../client.js";
import { getSegments } from "./draft.js";
import { segmentsFromPayload, verifySegmentBoundaries } from "./boundaries.js";

type City = JsonRecord;

export async function readTrafficLineSegmentReadback(
  page: TrafficLinePage,
  productId: string,
  variant: TrafficLineVariant,
  endpoints: TrafficLineEndpointPlan,
): Promise<{ segmentCount: number; departureCityCount: number }> {
  const payload = await getSegments(page, productId);
  const segments = segmentsFromPayload(payload);
  if (!segments.length) throw new Error("子产品未返回可作为正式回读的资源段。");
  verifySegmentBoundaries(segments, variant, endpoints);
  return { segmentCount: segments.length, departureCityCount: verifyValidatedDepartureCityReadback(payload) };
}

export function publishedSegmentReadbackIsComplete(
  payload: JsonRecord,
  variant: TrafficLineVariant,
  endpoints: TrafficLineEndpointPlan,
  expectedCities: City[] = [],
): boolean {
  if (Array.isArray(record(payload.draftProductSegments)?.segments)) return false;
  try {
    verifySegmentBoundaries(segmentsFromPayload(payload), variant, endpoints);
    if (!departureCityReadbackIsComplete(payload, expectedCities)) return false;
    return true;
  } catch {
    return false;
  }
}