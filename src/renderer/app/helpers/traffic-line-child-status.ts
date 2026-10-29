import { trafficChildSkipHandled } from "../../../shared/traffic-resource-status.js";
import { TRAFFIC_SKIP_LABELS, isTrafficSkipReason, trafficSkipReason } from "../../../shared/traffic-skip-reason.js";
import type { TrafficLineChildProgress, TrafficLineVariant } from "../../../shared/contracts-traffic-line.js";
import { durationSyncNote } from "../../../shared/traffic-duration-sync.js";

/** 与母产品结案同一口径：只有 skipped 标记且非玩法线路审核的子产品才显示已跳过。 */
function skipHandled(item: Record<string, unknown>): boolean {
  return trafficChildSkipHandled(item as unknown as TrafficLineChildProgress);
}

/** A fresh verified readback supersedes historical failure/skip display flags. */
export function trafficLineChildStatus(item: Record<string, unknown>, hasCompletedStages: boolean): string {
  if (item.verified === true) return "completed";
  for (const value of [item.status, item.state, item.nodeStatus]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  if (skipHandled(item)) return "skipped";
  if (typeof item.failureReason === "string" && item.failureReason.trim()) return "failed";
  if (typeof item.failedStage === "string" && item.failedStage.trim()) return "failed";
  return hasCompletedStages ? "running" : "pending";
}

export type TrafficLineStatusTone = "pending" | "running" | "done" | "skipped" | "failed";

/** 卡片色调：已跳过单独一档（警示黄），不与失败共用红色。 */
export function trafficLineStatusTone(status: string): TrafficLineStatusTone {
  if (status === "completed" || status === "succeeded") return "done";
  if (status === "skipped") return "skipped";
  if (status === "failed" || status === "needs_user") return "failed";
  if (status === "running" || status === "queued") return "running";
  return "pending";
}

export type TrafficReviewResourceState = "awaitingResource" | "checking" | "verified" | "skipped" | "failed";

/** 审查面板的班期资源状态；已跳过的子产品不会把整块面板标为失败。 */
export function trafficReviewResourceState(progress: Record<string, unknown> | null, checking: boolean, phaseFailed: boolean): TrafficReviewResourceState {
  if (progress?.verified === true) return "verified";
  if (progress && skipHandled(progress)) return "skipped";
  if (progress?.failureReason || phaseFailed) return "failed";
  return checking ? "checking" : "awaitingResource";
}

/** 跳过原因的展示文案；没有任何失败证据时不编造原因。 */
export function trafficLineSkipLabel(item: Record<string, unknown>): string | undefined {
  const reason = typeof item.failureReason === "string" ? item.failureReason.trim() : "";
  const kind = isTrafficSkipReason(item.skipReason) ? item.skipReason
    : reason ? trafficSkipReason(reason, item.variant as TrafficLineVariant) : undefined;
  if (!kind) return undefined;
  const note = durationSyncNote(reason);
  return note ? `${TRAFFIC_SKIP_LABELS[kind]}（${note}）` : TRAFFIC_SKIP_LABELS[kind];
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
