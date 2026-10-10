import { isUnavailableTrafficResourceFailure } from "../../../shared/traffic-resource-status.js";
import type { TrafficLineVariant } from "../../../shared/contracts-traffic-line.js";

/** A fresh verified readback supersedes historical failure/skip display flags. */
export function trafficLineChildStatus(item: Record<string, unknown>, hasCompletedStages: boolean): string {
  if (item.verified === true) return "completed";
  for (const value of [item.status, item.state, item.nodeStatus]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  if (typeof item.failureReason === "string" && item.failureReason.trim()
    && !isUnavailableTrafficResourceFailure(item.failureReason, item.variant as TrafficLineVariant)) return "failed";
  if (item.skipped === true) return "skipped";
  if (typeof item.failedStage === "string" && item.failedStage.trim()) return "failed";
  return hasCompletedStages ? "running" : "pending";
}

export function trafficLineEndpointHint(status: string, hasChild: boolean): string {
  if (status === "completed" || status === "succeeded") return "端点已确认 · 已完成 VBK 回读";
  if (status === "failed" || status === "needs_user") return "端点已确认 · 子产品仍需处理";
  if (status === "skipped") return "端点已确认 · 本轮已跳过";
  return hasChild ? "端点已确认 · 子产品核验中" : "端点已确认 · 待写入 VBK";
}

export function latestTrafficLineEndpointPlan(checkpoint: unknown, preparation: unknown): Record<string, unknown> | null {
  for (const value of [checkpoint, preparation]) {
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  }
  return null;
}
