import { isTrafficLineRouteReviewRequired } from "../../../shared/traffic-resource-status.js";
import { TRAFFIC_SKIP_LABELS, isTrafficSkipReason, trafficSkipReason } from "../../../shared/traffic-skip-reason.js";
import type { TrafficLineVariant } from "../../../shared/contracts-traffic-line.js";

/** A fresh verified readback supersedes historical failure/skip display flags. */
export function trafficLineChildStatus(item: Record<string, unknown>, hasCompletedStages: boolean): string {
  if (item.verified === true) return "completed";
  for (const value of [item.status, item.state, item.nodeStatus]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  // 玩法线路审核需用户授权后续跑，仍显示待处理；其它失败已跳过并保留原因。
  if (typeof item.failureReason === "string" && item.failureReason.trim()) {
    return isTrafficLineRouteReviewRequired(item.failureReason) ? "failed" : "skipped";
  }
  if (item.skipped === true) return "skipped";
  if (typeof item.failedStage === "string" && item.failedStage.trim()) return "failed";
  return hasCompletedStages ? "running" : "pending";
}

/** 跳过原因的展示文案；没有任何失败证据时不编造原因。 */
export function trafficLineSkipLabel(item: Record<string, unknown>): string | undefined {
  if (isTrafficSkipReason(item.skipReason)) return TRAFFIC_SKIP_LABELS[item.skipReason];
  const reason = typeof item.failureReason === "string" ? item.failureReason.trim() : "";
  return reason ? TRAFFIC_SKIP_LABELS[trafficSkipReason(reason, item.variant as TrafficLineVariant)] : undefined;
}

export function trafficLineEndpointHint(status: string, hasChild: boolean, skipLabel?: string): string {
  if (status === "completed" || status === "succeeded") return "端点已确认 · 已完成 VBK 回读";
  if (status === "failed" || status === "needs_user") return "端点已确认 · 子产品仍需处理";
  if (status === "skipped") return skipLabel ? `端点已确认 · 已跳过：${skipLabel}` : "端点已确认 · 本轮已跳过";
  return hasChild ? "端点已确认 · 子产品核验中" : "端点已确认 · 待写入 VBK";
}

export function latestTrafficLineEndpointPlan(checkpoint: unknown, preparation: unknown): Record<string, unknown> | null {
  for (const value of [checkpoint, preparation]) {
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  }
  return null;
}
