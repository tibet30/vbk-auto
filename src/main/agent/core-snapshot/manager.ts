/**
 * AgentSnapshotManager：
 *   - 把「Agent 状态机 + 事件流 + stage lifecycle + 持久化」封装为单一入口；
 *   - 状态机：load / save / event / result / newRun / running / waiting /
 *     pause / finish / terminal；
 *   - 交互：createApproval / cancelPendingInteraction / pendingCallId /
 *     validApproval / token / current；
 *   - 流式 + 恢复：publishStreaming / interruptStreaming / markUncertain /
 *     recoverInterruptedCalls / reconcileCall / cancelCalls / failures；
 *   - blocker 助手：blockedResult / completionBlocked /
 *     openNoProgressRetryWindow（pauseAfterRepeatedBlocker 委派给 blockers.ts）。
 *
 * 文件拆出来是为了把「事件读写 + 状态机切换」单独留作主类骨架，便于在
 * core-snapshot.ts 里只放 barrel / 类型 / 公开 helper。
 */

import type {
  AgentApproval, AgentEvent, AgentInputRequest, AgentRun, AgentRunStatus, AgentSnapshot,
} from "../../../shared/contracts.js";
import type { AgentSnapshotStore, AgentToolCall } from "./types.js";
import { hydrateAgentStages, recordAgentStageEvent } from "../../../shared/agent-stage-lifecycle.js";
import {
  hasUnresolvedAgentToolFailure, UNRESOLVED_TOOL_SUMMARY,
} from "../../../shared/agent-tool-outcomes.js";
import type { AgentStreamState, NoProgressBlocker, TurnToken } from "./types.js";
import { isMaterialWriteResult, materialWriteResults } from "./helpers.js";
import { collectNoProgressBlockers, noProgressPauseMessage } from "./blockers.js";

export class AgentSnapshotManager {
  constructor(
    private readonly store: AgentSnapshotStore,
    private readonly now: () => Date,
    private readonly id: () => string,
  ) {}

  load(id: string): AgentSnapshot {
    const stored = this.store.getAgentSnapshot(id);
    const snapshot = stored ? structuredClone(stored) : { localProductId: id, run: null, events: [] };
    hydrateAgentStages(snapshot);
    return snapshot;
  }

  save(snapshot: AgentSnapshot): AgentSnapshot {
    hydrateAgentStages(snapshot);
    const counts = new Map<string, number>();
    for (const event of snapshot.events) {
      const stageId = event.data?.stageId;
      if (typeof stageId === "string") counts.set(stageId, (counts.get(stageId) ?? 0) + 1);
    }
    snapshot.stages?.forEach((stage) => { stage.eventCount = counts.get(stage.id) ?? 0; });
    snapshot.updatedAt = this.now().toISOString();
    const saved = structuredClone(snapshot);
    this.store.saveAgentSnapshot(saved);
    return structuredClone(saved);
  }

  event(
    snapshot: AgentSnapshot,
    type: AgentEvent["type"],
    content: string,
    data?: Record<string, unknown>,
    runId = snapshot.run?.id ?? "",
  ): void {
    const event = { id: this.id(), runId, type, createdAt: this.now().toISOString(), content, ...(data ? { data } : {}) };
    snapshot.events.push(event);
    recordAgentStageEvent(snapshot, event);
  }

  result(snapshot: AgentSnapshot, toolCallId: string, content: string, data?: Record<string, unknown>, runId?: string): void {
    this.event(snapshot, "tool_result", content, { ...(data ?? {}), toolCallId }, runId);
  }

  newRun(status: AgentRunStatus): AgentRun {
    const timestamp = this.now().toISOString();
    return { id: this.id(), status, createdAt: timestamp, updatedAt: timestamp };
  }

  touch(run: AgentRun): void { run.updatedAt = this.now().toISOString(); }

  running(snapshot: AgentSnapshot): void {
    if (!snapshot.run) return;
    snapshot.run.status = "running";
    this.touch(snapshot.run);
    this.event(snapshot, "status", "运行中", { status: "running" });
  }

  waiting(snapshot: AgentSnapshot, status: "waiting_input" | "waiting_approval"): void {
    if (!snapshot.run) return;
    snapshot.run.status = status;
    this.touch(snapshot.run);
    this.event(snapshot, "status", status, { status });
  }

  pause(snapshot: AgentSnapshot, content: string): void {
    if (!snapshot.run) return;
    if (snapshot.run.status === "completed") {
      const stage = snapshot.stages?.at(-1);
      if (stage?.runId === snapshot.run.id && stage.status === "completed") {
        stage.status = "superseded"; stage.summary = "此前的完成结论已撤销，执行过程保留。"; stage.nextStep = undefined;
      }
    }
    snapshot.run.status = "paused";
    this.touch(snapshot.run);
    this.event(snapshot, "status", content, { status: "paused" });
  }

  finish(snapshot: AgentSnapshot, verified = false): void {
    if (!snapshot.run) return;
    if (!verified && hasUnresolvedAgentToolFailure(snapshot.events, snapshot.run.id)) {
      this.pause(snapshot, UNRESOLVED_TOOL_SUMMARY);
      return;
    }
    snapshot.run.status = "completed";
    this.touch(snapshot.run);
    this.event(snapshot, "status", "任务已完成", { status: "completed", ...(verified ? { completionVerified: true } : {}) });
  }

  terminal(status: AgentRunStatus): boolean { return ["completed", "abandoned"].includes(status); }

  token(snapshot: AgentSnapshot): TurnToken {
    return { runId: snapshot.run!.id, userEventId: this.latestUserId(snapshot) };
  }

  current(snapshot: AgentSnapshot, token: TurnToken): boolean {
    return snapshot.run?.id === token.runId && snapshot.run.status === "running"
      && !snapshot.uncertainWrite && this.latestUserId(snapshot) === token.userEventId;
  }

  pendingCallId(snapshot: AgentSnapshot, type: AgentEvent["type"], interactionId: string): string | undefined {
    const event = [...snapshot.events].reverse().find((candidate) => candidate.type === type
      && ((candidate.data?.request as AgentInputRequest | undefined)?.id === interactionId
        || (candidate.data?.approval as AgentApproval | undefined)?.id === interactionId));
    return typeof event?.data?.toolCallId === "string" ? event.data.toolCallId : undefined;
  }

  validApproval(snapshot: AgentSnapshot): AgentApproval | undefined {
    const event = [...snapshot.events].reverse().find((candidate) => candidate.type === "approval"
      && candidate.runId === snapshot.run?.id
      && (candidate.data?.approval as AgentApproval | undefined)?.status === "approved"
      && (candidate.data?.approval as AgentApproval | undefined)?.intentVersion === snapshot.run?.intentVersion);
    return event?.data?.approval as AgentApproval | undefined;
  }

  createApproval(
    snapshot: AgentSnapshot,
    scope: string[],
    summary: string,
    identity: { accountKey: string; productVersion: string },
    toolCallId?: string,
    runId = snapshot.run?.id,
  ): void {
    if (!scope.length || !summary || !snapshot.run) {
      if (toolCallId) this.result(snapshot, toolCallId, "审批范围或说明无效。", { executionRejected: true }, runId);
      return;
    }
    const approval: AgentApproval = {
      id: this.id(),
      productVersion: identity.productVersion,
      accountKey: identity.accountKey,
      scope,
      summary,
      status: "pending",
      createdAt: this.now().toISOString(),
      intentVersion: snapshot.run.intentVersion,
    };
    snapshot.pendingApproval = approval;
    this.event(snapshot, "approval_request", summary, { ...(toolCallId ? { toolCallId } : {}), approval }, runId);
    this.waiting(snapshot, "waiting_approval");
  }

  cancelPendingInteraction(snapshot: AgentSnapshot, reason: string): void {
    if (snapshot.pendingInput) {
      const callId = this.pendingCallId(snapshot, "input_request", snapshot.pendingInput.id);
      if (callId) this.result(snapshot, callId, reason, { cancelled: true });
      snapshot.pendingInput = undefined;
    }
    if (snapshot.pendingApproval) {
      const approval = snapshot.pendingApproval;
      approval.status = "invalidated";
      const callId = this.pendingCallId(snapshot, "approval_request", approval.id);
      this.event(snapshot, "approval", reason, { approval });
      if (callId) this.result(snapshot, callId, reason, { cancelled: true });
      snapshot.pendingApproval = undefined;
    }
  }

  interruptStreaming(snapshot: AgentSnapshot, reason: string, modelTurnId?: string): void {
    snapshot.events.forEach((event) => {
      if (event.type !== "assistant" || event.data?.streaming !== true) return;
      if (modelTurnId && event.data.modelTurnId !== modelTurnId) return;
      event.data = { ...event.data, streaming: false, interrupted: true, interruptedReason: reason };
    });
  }

  publishStreaming(id: string, token: TurnToken, modelTurnId: string, state: AgentStreamState, content: string): void {
    const snapshot = this.load(id);
    if (!this.current(snapshot, token)) return;
    const existing = state.eventId
      ? snapshot.events.find((event) => event.id === state.eventId)
      : snapshot.events.find((event) => event.type === "assistant" && event.data?.modelTurnId === modelTurnId);
    if (!content) {
      if (existing) snapshot.events = snapshot.events.filter((event) => event.id !== existing.id);
      state.eventId = undefined;
      state.lastSavedAt = 0;
      if (existing) this.save(snapshot);
      return;
    }
    const now = Date.now();
    if (existing && now - state.lastSavedAt < 48) return;
    if (existing) existing.content = content;
    else {
      this.event(snapshot, "assistant", content, { modelTurnId, streaming: true });
      state.eventId = snapshot.events.at(-1)?.id;
    }
    state.lastSavedAt = now;
    this.save(snapshot);
  }

  blockedResult(
    snapshot: AgentSnapshot,
    toolCallId: string,
    message: string,
    blocker: NoProgressBlocker,
    data?: Record<string, unknown>,
    runId?: string,
  ): void {
    this.result(snapshot, toolCallId, message, { ...(data ?? {}), noProgressBlocker: blocker }, runId);
    this.pauseAfterRepeatedBlocker(snapshot);
  }

  completionBlocked(snapshot: AgentSnapshot, message: string, blocker: NoProgressBlocker = "completion_blocked"): void {
    this.event(snapshot, "status", message, {
      completionBlocked: true,
      modelFeedback: true,
      noProgressBlocker: blocker,
    });
    this.pauseAfterRepeatedBlocker(snapshot);
  }

  openNoProgressRetryWindow(snapshot: AgentSnapshot): void {
    const latestPause = [...snapshot.events].reverse().find((event) => event.runId === snapshot.run?.id
      && event.type === "status" && event.data?.status === "paused");
    if (latestPause?.data?.noProgressPaused !== true) return;
    this.event(snapshot, "status", "用户已明确继续，开启新的有限重试窗口。", { noProgressRetryWindow: true });
  }

  cancelCalls(snapshot: AgentSnapshot, calls: AgentToolCall[], token: TurnToken, content: string): void {
    const completed = new Set(snapshot.events.filter((event) => event.type === "tool_result")
      .flatMap((event) => typeof event.data?.toolCallId === "string" ? [event.data.toolCallId] : []));
    for (const call of calls) if (!completed.has(call.id)) this.result(snapshot, call.id, content, { cancelled: true }, token.runId);
  }

  failures(snapshot: AgentSnapshot, call: AgentToolCall, message: string): number {
    const key = JSON.stringify({ name: call.name, arguments: call.arguments });
    let count = 0;
    for (const event of [...snapshot.events].reverse()) {
      if (event.type !== "tool_result" || !event.data?.error) continue;
      const sameError = event.data.error === message || event.content.startsWith(`工具失败：${message}`);
      if (!sameError || this.callKey(snapshot, String(event.data.toolCallId)) !== key) break;
      count += 1;
    }
    return count;
  }

  private pauseAfterRepeatedBlocker(snapshot: AgentSnapshot): void {
    const blockers = collectNoProgressBlockers(snapshot);
    if (!snapshot.run || blockers.length < 3) return;
    snapshot.run.status = "paused";
    this.touch(snapshot.run);
    this.event(snapshot, "status", noProgressPauseMessage(blockers), {
      status: "paused",
      noProgressPaused: true,
      noProgressBlockers: blockers.slice(-3).map((event) => event.data?.noProgressBlocker),
      noProgressLatestReason: blockers.at(-1)?.content,
    });
  }

  markUncertain(snapshot: AgentSnapshot, toolCallId: string, message: string): void {
    snapshot.uncertainWrite = { toolCallId, message, createdAt: this.now().toISOString() };
    if (snapshot.run && !this.terminal(snapshot.run.status)) this.pause(snapshot, "写入结果不确定，已暂停等待权威核对。");
  }

  recoverInterruptedCalls(snapshot: AgentSnapshot): boolean {
    if (snapshot.pendingInput || snapshot.pendingApproval) return false;
    const completed = new Set(snapshot.events.filter((event) => event.type === "tool_result")
      .flatMap((event) => typeof event.data?.toolCallId === "string" ? [event.data.toolCallId] : []));
    const dispatched = new Map(snapshot.events.flatMap((event) => event.data?.writeDispatch === true
      && typeof event.data.toolCallId === "string" ? [[event.data.toolCallId, event] as const] : []));
    const interrupted = snapshot.events.filter((event) => event.type === "tool_call"
      && typeof event.data?.toolCallId === "string" && !completed.has(event.data.toolCallId));
    for (const call of interrupted) {
      const callId = call.data!.toolCallId as string;
      if (!dispatched.has(callId)) {
        this.result(snapshot, callId, "应用中断前尚未执行。", { cancelled: true, recovered: true }, call.runId);
      }
    }
    if (snapshot.uncertainWrite) return true;
    const dispatch = [...interrupted].reverse().map((call) => dispatched.get(call.data!.toolCallId as string))
      .find((event) => event !== undefined);
    if (!dispatch || typeof dispatch.data?.toolCallId !== "string") return interrupted.length > 0;
    const name = typeof dispatch.data.name === "string" ? dispatch.data.name : dispatch.content;
    this.markUncertain(snapshot, dispatch.data.toolCallId, `外部操作 ${name} 已发出，但应用未保存返回结果。`);
    return true;
  }

  reconcileCall(snapshot: AgentSnapshot, toolCallId: string, content: string): void {
    const alreadyCompleted = snapshot.events.some((event) => event.type === "tool_result"
      && event.data?.toolCallId === toolCallId);
    if (!alreadyCompleted) this.result(snapshot, toolCallId, content, { reconciled: true });
  }

  private latestUserId(snapshot: AgentSnapshot): string | undefined {
    return [...snapshot.events].reverse().find((event) => event.type === "user" && event.data?.readOnlyStatusQuery !== true)?.id;
  }

  private callKey(snapshot: AgentSnapshot, id: string): string | undefined {
    const event = snapshot.events.find((candidate) => candidate.type === "tool_call" && candidate.data?.toolCallId === id);
    const name = typeof event?.data?.name === "string" ? event.data.name : event?.content;
    return event ? JSON.stringify({ name, arguments: event.data?.arguments }) : undefined;
  }

  // Internal access for blockers / helpers that need to re-use materialWriteResults.
  protected _collectNoProgressBlockers = collectNoProgressBlockers;
  protected _noProgressPauseMessage = noProgressPauseMessage;
  protected _materialWriteResults = materialWriteResults;
  protected _isMaterialWriteResult = isMaterialWriteResult;
}