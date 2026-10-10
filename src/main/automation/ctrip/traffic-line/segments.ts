/**
 * traffic-line/segments 子模块（barrel）：
 *   - ensureTrafficLineSegments：子产品资源段完整提交流水线；
 *   - readTrafficLineSegmentReadback：只读回读；
 *   - publishedSegmentReadbackIsComplete：publishSegmentModule 超时兼容；
 *   - recoverPendingTrafficLineSegmentSubmit：恢复超时任务。
 *
 * 子文件分工：
 *   - draft.ts：SOA 调用层（getSegments / saveSegment / saveDepartureCities /
 *     publishSegmentModule / ensureSegmentDraft / resolveTrafficLineModifyUser /
 *     trafficLineModifyUserFromState）；
 *   - boundaries.ts：segmentsFromPayload / buildBoundarySegment /
 *     verifySegmentBoundaries / verifyStationReadback / inferDestination /
 *     isMultiCity / multiCity；
 *   - cities.ts：compatibleDepartureCities / selectTrafficLineValidationCities；
 *   - dates.ts：trafficLineResourceCheckDates / resourceCheckSchedule /
 *     deterministicSchedule；
 *   - readback.ts：readTrafficLineSegmentReadback / publishedSegmentReadbackIsComplete；
 *   - submit.ts：ensureTrafficLineSegments / recoverPendingTrafficLineSegmentSubmit。
 *
 * 同时把 withTraffic / waitForSegmentSubmit / trafficLineResourcePageUrl / validatedSegmentReadbackIsComplete
 * 从 segment-traffic / segment-submit / segment-validation-readback re-export，
 * 保留调用方零改动。
 */

export { withTraffic } from "./segment-traffic.js";
export { waitForSegmentSubmit, trafficLineResourcePageUrl } from "./segment-submit.js";
export { validatedSegmentReadbackIsComplete } from "./segment-validation-readback.js";

export { ensureTrafficLineSegments, recoverPendingTrafficLineSegmentSubmit, trafficLineResourceCheckDates } from "./segments/submit.js";
export { readTrafficLineSegmentReadback, publishedSegmentReadbackIsComplete } from "./segments/readback.js";
export { segmentsFromPayload, buildBoundarySegment, verifySegmentBoundaries } from "./segments/boundaries.js";
export { compatibleDepartureCities, selectTrafficLineValidationCities } from "./segments/cities.js";
export { resourceCheckSchedule, deterministicSchedule } from "./segments/dates.js";
export { getSegments } from "./segments/draft.js";
export type { TrafficLineSegmentSubmitRecovery } from "./segments/submit.js";