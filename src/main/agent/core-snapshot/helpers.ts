/**
 * AgentSnapshotManager 公共 classify 助手：
 *   - isMaterialWriteResult：writer 工具事件是否真正改动了 product（write=true、
 *     工具未失败、且 changedSections 非空）；
 *   - materialWriteResults：按 runId 聚合 product 真实写入事件；
 *   - hasSyntheticNoopApproval：识别历史上由 denied/no-op 工具合成出的
 *     「最终确认」卡片（用于 reject 时跳过同源 pin）。
 */

import type { AgentApproval, AgentEvent, AgentSnapshot } from "./types.js";
import { failedAgentToolResult } from "../../../shared/agent-tool-outcomes.js";

export function isMaterialWriteResult(event: AgentEvent): boolean {
  if (event.type !== "tool_result" || event.data?.write !== true) return false;
  if (failedAgentToolResult(event)) return false;
  return !Array.isArray(event.data.changedSections) || event.data.changedSections.length > 0;
}

export function materialWriteResults(snapshot: AgentSnapshot, runId = snapshot.run?.id): AgentEvent[] {
  if (!runId) return [];
  return snapshot.events.filter((event) => event.runId === runId && isMaterialWriteResult(event));
}

/** Repair final-approval cards historically synthesized from denied/no-op tools. */
export function hasSyntheticNoopApproval(snapshot: AgentSnapshot): boolean {
  const approval = snapshot.pendingApproval;
  if (!approval || approval.status !== "pending" || !snapshot.run) return false;
  const request = [...snapshot.events].reverse().find((event) => event.runId === snapshot.run!.id
    && event.type === "approval_request"
    && (event.data?.approval as AgentApproval | undefined)?.id === approval.id);
  if (approval.replayOfAutomationRunId && snapshot.events.some(event =>
    event.runId === snapshot.run!.id && event.type === "user" && event.data?.fullWorkflowReplay === true)) return false;
  return Boolean(request && typeof request.data?.toolCallId !== "string"
    && materialWriteResults(snapshot, snapshot.run.id).length === 0);
}