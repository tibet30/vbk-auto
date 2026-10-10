import { TRAFFIC_LINE_CHILD_STAGES, type TrafficLineChildProgress } from "../../../../shared/contracts-traffic-line.js";
import { isUnavailableTrafficResourceFailure, isTrafficLineRouteReviewRequired } from "../../../../shared/traffic-resource-status.js";

export function trafficRouteActivationCanResume(progress?: TrafficLineChildProgress): boolean {
  return progress?.failedStage === "activated" && isTrafficLineRouteReviewRequired(progress.failureReason ?? "")
    && (["resourcesSaved", "itinerarySaved", "clausesSaved"] as const).every(stage => progress.completedStages.includes(stage));
}

export function trafficSegmentSubmitNeedsRecovery(progress?: TrafficLineChildProgress): boolean {
  // 老 checkpoint 可能保留之前成功的 resourcesSaved，从而把新一轮资源超时
  // 错标成 activated。异步恢复以实际提交证据和失败原因判断，不能只看阶段名。
  return Boolean(progress?.validationSubmittedAt)
    && (/(?:轮询后仍未完成|仍在 VBK 异步核验)/.test(progress?.failureReason ?? "")
      || (!progress?.failureReason && !progress?.completedStages.includes("resourcesSaved")));
}

/** 已核验的正式资源不因条款物化迟到重新提交；入口仍必须独立回读资源。 */
export function trafficClauseMaterializationCanResume(progress?: TrafficLineChildProgress): boolean {
  return Boolean(progress?.childProductId && progress.validationSubmittedAt)
    && ["clausesSaved", "activated"].includes(progress?.failedStage ?? "")
    && /子产品资源回读尚未生成(?:飞机|火车)去返程条款|子产品资源提交未通过：资源配置中含有(?:机票|火车票)资源，需要行程描述中先添加(?:航班|火车)信息卡片/.test(progress?.failureReason ?? "")
    && (["resourcesSaved", "itinerarySaved"] as const).every(stage => progress!.completedStages.includes(stage));
}

/** 旧提交因卡片缺失被拒绝时，正式资源可能仍在；只允许进入权威回读恢复。 */
export function trafficResourceCardRejected(progress?: TrafficLineChildProgress): boolean {
  return Boolean(progress?.childProductId && progress.validationSubmittedAt)
    && progress?.failedStage === "resourcesSaved"
    && progress.completedStages.includes("presentationCopied")
    && /子产品资源提交未通过：资源配置中含有(?:机票|火车票)资源，需要行程描述中先添加(?:航班|火车)信息卡片/.test(progress.failureReason ?? "");
}

/** Optional children may continue independently; protocol failures remain retryable failures. */
export function trafficLineFailureProgress(progress: TrafficLineChildProgress, reason: string): TrafficLineChildProgress {
  const unavailable = isUnavailableTrafficResourceFailure(reason, progress.variant);
  return { ...progress, verified: false, skipped: unavailable,
    failedStage: unavailable ? undefined : TRAFFIC_LINE_CHILD_STAGES.find(stage => !progress.completedStages.includes(stage)) ?? "finalReadback",
    failureReason: reason };
}
