/**
 * core-snapshot 公共类型 + 工具函数：
 *   - TurnToken：当前 run 的稳定标识（runId / userEventId / modelTurnId）；
 *   - AgentStreamState：流式 assistant 事件复用同一 eventId 时记录的上次保存时间；
 *   - NoProgressBlocker：blockedResult / completionBlocked 写入的 blocker 三元分类。
 *
 * 文件单独抽出的目的：主类只通过这些类型字段与外部交互，避免类文件循环依赖。
 */

import type { AgentEvent, AgentEventType, AgentInputRequest, AgentApproval, AgentSnapshot } from "../../../shared/contracts.js";
import type { AgentSnapshotStore, AgentToolCall } from "../types.js";

export interface TurnToken {
  runId: string;
  userEventId?: string;
  modelTurnId?: string;
}

export interface AgentStreamState {
  eventId?: string;
  lastSavedAt: number;
}

export type NoProgressBlocker = "approval_precondition" | "authorization_denied" | "completion_blocked";

// Re-export to keep existing import paths stable.
export type { AgentEvent, AgentEventType, AgentInputRequest, AgentApproval, AgentSnapshot, AgentSnapshotStore, AgentToolCall };