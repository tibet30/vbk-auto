/**
 * ensureTrafficLineSegments 主流程 + 恢复：
 *   - 初始化草稿（ensureSegmentDraft），首末段补齐"多出发 / 多到达"边界；
 *   - 写首末段交通配置（withTraffic），verifySegmentBoundaries 立即回读；
 *   - 取多出发城市 → 写 SaveSegmentCommonData → publishProductModules → 二次回读
 *     + 写多出发城市 → saveSegment 边界 → beforeSubmit（vehicle draft + itinerary）→
 *     submitSegments + waitFor segment submit → 若有被拒城市，三轮内重试；
 *   - submit 完成后 waitForValidatedSegmentReadback 拿正式资源 + 校验多出发 / 多到达；
 *   - 一切就绪返回 { segmentCount, departureCityCount }。
 *
 *   recoverPendingTrafficLineSegmentSubmit：
 *     恢复时先读 submitSegments 状态——pending 继续等 / failed & missing 直接 retry；
 *     已成功则补齐正式资源回读。
 */

import type { TrafficLineEndpointPlan, TrafficLineVariant } from "../../../../../shared/contracts-traffic-line.js";
import { postTrafficLineSoa, type JsonRecord, type TrafficLinePage } from "../client.js";
import { verifyDepartureCityReadback, verifyValidatedDepartureCityReadback } from "../segment-departure-cities.js";
import { waitForSegmentSubmit } from "../segment-submit.js";
import { waitForValidatedSegmentReadback } from "../segment-validation-readback.js";
import {
  ensureSegmentDraft,
  getSegments,
  publishSegmentModule,
  resolveTrafficLineModifyUser,
  saveDepartureCities,
  saveSegment,
} from "./draft.js";
import { compatibleDepartureCities } from "./cities.js";
import { trafficLineResourceCheckDates, resourceCheckSchedule } from "./dates.js";
import {
  buildBoundarySegment,
  inferDestination,
  isMultiArrival,
  isMultiDeparture,
  multiCity,
  segmentsFromPayload,
  verifySegmentBoundaries,
} from "./boundaries.js";
import { withTraffic } from "../segment-traffic.js";

export type TrafficLineSegmentSubmitRecovery = "recovered" | "restartable" | "pending";

export async function ensureTrafficLineSegments(
  page: TrafficLinePage,
  productId: string,
  variant: TrafficLineVariant,
  endpoints: TrafficLineEndpointPlan,
  options: {
    maxPolls?: number;
    sleep?: (milliseconds: number) => Promise<void>;
    now?: Date;
    /** 母产品实际售卖班期；平台用此集合而不是任意未来日期校验交通资源。 */
    schedule?: readonly string[];
    beforeSubmit?: () => Promise<void>;
    onSubmit?: (departureCityCount: number) => void;
    onValidationProgress?: (attempt: number, maxPolls: number) => void;
    shouldStopWaiting?: () => boolean;
  } = {},
): Promise<{ segmentCount: number; departureCityCount: number }> {
  const before = await ensureSegmentDraft(page, productId, options.sleep);
  let current = segmentsFromPayload(before);
  if (!current.length) throw new Error("子产品资源配置未返回任何行程段。");
  const destination = inferDestination(current);
  if (!isMultiDeparture(current[0]!)) {
    await saveSegment(page, buildBoundarySegment(current[0]!, 1, multiCity("多出发"), destination));
    current = segmentsFromPayload(await getSegments(page, productId));
    if (!current.length || !isMultiDeparture(current[0]!)) {
      throw new Error("保存多出发资源段后平台回读不一致。");
    }
  }
  if (!current.length) throw new Error("保存多出发资源段后未返回任何行程段。");
  if (!isMultiArrival(current.at(-1)!)) {
    await saveSegment(page, buildBoundarySegment(current.at(-1)!, current.length + 1, destination, multiCity("多到达")));
  }

  const draft = await getSegments(page, productId);
  const segments = segmentsFromPayload(draft);
  if (segments.length < 2) throw new Error("子产品资源段边界保存后未返回首末段。");
  const first = segments[0]!;
  const last = segments.at(-1)!;
  await saveSegment(page, withTraffic(first, variant, "enter", endpoints));
  await saveSegment(page, withTraffic(last, variant, "leave", endpoints));
  verifySegmentBoundaries(segmentsFromPayload(await getSegments(page, productId)), variant, endpoints);

  const cities = await compatibleDepartureCities(page, variant, destination);
  if (!cities.length) throw new Error(`VBK 未返回可用于${variant === "flightRoundTrip" ? "飞机" : "火车"}往返的出发城市。`);
  const modifyUser = await resolveTrafficLineModifyUser(page, productId);
  let selectedCities = cities;
  for (let round = 1; round <= 3; round += 1) {
    await saveDepartureCities(page, productId, selectedCities);
    verifyDepartureCityReadback(await getSegments(page, productId), selectedCities);
    // publishProductModules 会把可写 draft 结算为正式资源，同时让 TourDays
    // 生成首末日交通节点。结算后必须重建并回读 draft，再度保存
    // 多出发城市与行程卡片，否则 submitSegments 虽可能返回 Ack=Success，
    // 实际不会创建班期校验任务。
    await publishSegmentModule(page, productId, modifyUser, variant, endpoints, selectedCities);
    const submitDraft = segmentsFromPayload(await ensureSegmentDraft(page, productId, options.sleep));
    verifySegmentBoundaries(submitDraft, variant, endpoints);
    await saveDepartureCities(page, productId, selectedCities);
    verifyDepartureCityReadback(await getSegments(page, productId), selectedCities);
    await options.beforeSubmit?.();
    verifySegmentBoundaries(segmentsFromPayload(await getSegments(page, productId)), variant, endpoints);
    options.onSubmit?.(selectedCities.length);
    await postTrafficLineSoa(page, "15638", "submitSegments", {
      productId, schedule: resourceCheckSchedule(options.schedule, options.now), adultCount: 2, childCount: 0, audit: { saveStep: 2 },
    }, "提交子产品资源段");
    const rejectedCityIds = await waitForSegmentSubmit(page, productId, {
      submittedCityIds: selectedCities.map(city => text(city.cityId)),
      maxPolls: options.maxPolls,
      onProgress: options.onValidationProgress,
      shouldStopWaiting: options.shouldStopWaiting,
    });
    if (!rejectedCityIds.length) break;
    const rejected = new Set(rejectedCityIds);
    const nextCities = selectedCities.filter((city) => !rejected.has(text(city.cityId)));
    if (!nextCities.length) throw new Error("VBK 校验后没有任何可用的多出发城市，子产品未激活。");
    if (nextCities.length === selectedCities.length || round === 3) {
      throw new Error("VBK 多出发城市校验连续失败，已停止重试且子产品未激活。");
    }
    selectedCities = nextCities;
  }

  // result=T 可能已剔除无票城市；只读等待正式资源，不把原始城市集合写回。
  const finalPayload = await waitForValidatedSegmentReadback(
    page, productId, variant, endpoints, selectedCities, options.sleep,
  );
  const verified = segmentsFromPayload(finalPayload);
  verifySegmentBoundaries(verified, variant, endpoints);
  const departureCityCount = verifyValidatedDepartureCityReadback(finalPayload, selectedCities);
  return { segmentCount: verified.length, departureCityCount };
}

/**
 * 恢复超时任务时先读取上一次 submitSegments 的结果。若平台仍在处理则明确
 * 暂停；若已成功则补齐正式资源回读；仅在明确失败/不存在时允许重新构建草稿。
 */
export async function recoverPendingTrafficLineSegmentSubmit(
  page: TrafficLinePage,
  productId: string,
  variant: TrafficLineVariant,
  endpoints: TrafficLineEndpointPlan,
  options: {
    maxPolls?: number;
    sleep?: (milliseconds: number) => Promise<void>;
    onProgress?: (attempt: number, maxPolls: number) => void;
    shouldStopWaiting?: () => boolean;
  } = {},
): Promise<TrafficLineSegmentSubmitRecovery> {
  const state = await readSegmentSubmitState(page, productId);
  if (state.status === "missing" || state.status === "failed") return "restartable";
  if (state.status === "pending") {
    try {
      const rejectedCityIds = await waitForSegmentSubmit(page, productId, {
        maxPolls: options.maxPolls,
        sleep: options.sleep,
        onProgress: options.onProgress,
        shouldStopWaiting: options.shouldStopWaiting,
      });
      if (rejectedCityIds.length) return "restartable";
    } catch (error) {
      if (/未启动班期校验/.test(String(error))) return "restartable";
      return "pending";
    }
  }
  await waitForValidatedSegmentReadback(page, productId, variant, endpoints, [], options.sleep);
  return "recovered";
}

// Re-export local helpers used by callers
export { trafficLineResourceCheckDates } from "./dates.js";
// Helper exposed for direct callers / tests
import { readSegmentSubmitState } from "../segment-submit.js";
import { text } from "../client.js";