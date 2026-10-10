/**
 * AgentCore ——agent 主循环入口。
 *
 * 这是「slim 编排层」：把每个 public method 的实现抽到 core/ 子文件里
 * （get / send / approve / respond / pause / resume / ...），本文件只保留
 * 类声明、构造器、command gate 串行化、以及 1 行委托给 helper 的 method。
 *
 * 调用方拿到的仍是 AgentCore 类，API 形态完全不变。
 *
 * core/*.ts 的 helper 通过 `AgentCoreInternals` 接口访问 private 成员：
 * 不在仓库其它位置 import AgentCoreInternals；这是包内 friend 约定。
 */

import type {
  AgentApprovalResponse,
  AgentEvent,
  AgentEventType,
  AgentIllegalKeywordRepairInput,
  AgentInputResponse,
  AgentRun,
  AgentRunStatus,
  AgentSnapshot,
} from "../../shared/contracts.js";
import { AgentHandoff } from "./core-handoff.js";
import { AgentTurnLoop } from "./core-loop.js";
import { AgentSnapshotManager, hasSyntheticNoopApproval, type NoProgressBlocker } from "./core-snapshot.js";
import { AgentToolRunner } from "./core-tools.js";
import { refreshPendingInput } from "./core-pending-input.js";
import type { AgentCoreDependencies, AgentSnapshotStore } from "./types.js";
export type { AgentSnapshotStore } from "./types.js";
export { isPendingApprovalStatusFollowup, preservesApprovedIntent } from "./approval-intent.js";

import { getSnapshot, reconcilePendingInput } from "./core/get.js";
import { sendCommand } from "./core/send.js";
import {
  approveCommand,
  repairIllegalKeywordsCommand,
  respondCommand,
} from "./core/approval.js";
import {
  abandonCommand,
  pauseCommand,
  resumeCommand,
} from "./core/lifecycle.js";

/**
 * 内部 view ——供同包内的 core/*.ts helper 访问 AgentCore 的 private 成员。
 * 不要在仓库其它位置 import 本类型；所有外部调用都走 AgentCore 的 public 方法。
 */
export interface AgentCoreInternals {
  readonly deps: AgentCoreDependencies;
  readonly active: Set<string>;
  readonly scheduled: Set<string>;
  readonly snapshots: AgentSnapshotManager;
  readonly handoffs: AgentHandoff;
  readonly loop: AgentTurnLoop;
  command<T>(id: string, operation: () => Promise<T>): Promise<T>;
  load(id: string): AgentSnapshot;
  save(snapshot: AgentSnapshot): AgentSnapshot;
  event(snapshot: AgentSnapshot, type: AgentEvent["type"], content: string, data?: Record<string, unknown>, runId?: string): void;
  result(snapshot: AgentSnapshot, toolCallId: string, content: string, data?: Record<string, unknown>, runId?: string): void;
  cancelPendingInteraction(snapshot: AgentSnapshot, reason: string): void;
  refreshPendingInput(id: string, snapshot: AgentSnapshot): { changed: boolean; shouldSchedule: boolean };
  blockedResult(snapshot: AgentSnapshot, toolCallId: string, message: string, blocker: NoProgressBlocker, data?: Record<string, unknown>, runId?: string): void;
  completionBlocked(snapshot: AgentSnapshot, message: string, blocker?: NoProgressBlocker): void;
  pendingCallId(snapshot: AgentSnapshot, type: AgentEventType, interactionId: string): string | undefined;
  run(status: AgentRunStatus): AgentRun;
  touch(run: AgentRun): void;
  running(snapshot: AgentSnapshot): void;
  waiting(snapshot: AgentSnapshot, status: "waiting_input" | "waiting_approval"): void;
  pauseRun(snapshot: AgentSnapshot, content: string): void;
  terminal(status: AgentRunStatus): boolean;
  intent(id: string): Promise<string>;
}

/** Cast helper：core/*.ts 在函数顶部使用，避免每个调用点都重复 `as unknown as AgentCoreInternals`。 */
export function asCoreInternals(core: AgentCore): AgentCoreInternals {
  return core as unknown as AgentCoreInternals;
}

export class AgentCore {
  private readonly active = new Set<string>();
  private readonly scheduled = new Set<string>();
  private readonly commandTails = new Map<string, Promise<void>>();
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly snapshots: AgentSnapshotManager;
  private readonly toolRunner: AgentToolRunner;
  private readonly handoffs: AgentHandoff;
  private readonly loop: AgentTurnLoop;

  constructor(private readonly deps: AgentCoreDependencies, store: AgentSnapshotStore) {
    this.now = deps.now ?? (() => new Date());
    this.id = deps.id ?? (() => crypto.randomUUID());
    this.snapshots = new AgentSnapshotManager(store, this.now, this.id);
    this.toolRunner = new AgentToolRunner(deps, this.snapshots, this.now, this.id);
    this.handoffs = new AgentHandoff(deps, this.snapshots, (id, operation) => this.command(id, operation));
    this.loop = new AgentTurnLoop(deps, this.snapshots, this.toolRunner, this.id, this.active, this.scheduled);
  }

  get(id: string): Promise<AgentSnapshot> { return getSnapshot(this, id); }
  reconcilePendingInput(id: string): Promise<AgentSnapshot> { return reconcilePendingInput(this, id); }
  send(id: string, content: string): Promise<AgentSnapshot> { return sendCommand(this, id, content); }
  repairIllegalKeywords(id: string, input: AgentIllegalKeywordRepairInput): Promise<AgentSnapshot> {
    return repairIllegalKeywordsCommand(this, id, input);
  }
  respond(id: string, response: AgentInputResponse): Promise<AgentSnapshot> { return respondCommand(this, id, response); }
  approve(id: string, response: AgentApprovalResponse): Promise<AgentSnapshot> { return approveCommand(this, id, response); }
  pause(id: string): Promise<AgentSnapshot> { return pauseCommand(this, id); }
  resume(id: string): Promise<AgentSnapshot> { return resumeCommand(this, id); }
  abandon(id: string): Promise<AgentSnapshot> { return abandonCommand(this, id); }

  async completeApprovedWorkflow(id: string, approvalId: string): Promise<AgentSnapshot> {
    return this.handoffs.complete(id, approvalId);
  }

  async pauseApprovedWorkflow(id: string, approvalId: string, message: string): Promise<AgentSnapshot> {
    return this.handoffs.pause(id, approvalId, message);
  }

  async idle(id: string): Promise<void> {
    while (this.active.has(id) || this.scheduled.has(id) || this.commandTails.has(id)) {
      await new Promise((done) => setTimeout(done, 1));
    }
  }

  private cancelPendingInteraction(snapshot: AgentSnapshot, reason: string): void { this.snapshots.cancelPendingInteraction(snapshot, reason); }
  private refreshPendingInput(id: string, snapshot: AgentSnapshot) {
    return refreshPendingInput({ id, snapshot, deps: this.deps, snapshots: this.snapshots });
  }
  private blockedResult(snapshot: AgentSnapshot, toolCallId: string, message: string, blocker: NoProgressBlocker,
    data?: Record<string, unknown>, runId?: string): void {
    this.snapshots.blockedResult(snapshot, toolCallId, message, blocker, data, runId);
  }
  private completionBlocked(snapshot: AgentSnapshot, message: string, blocker?: NoProgressBlocker): void {
    this.snapshots.completionBlocked(snapshot, message, blocker);
  }
  private pendingCallId(snapshot: AgentSnapshot, type: AgentEventType, interactionId: string): string | undefined {
    return this.snapshots.pendingCallId(snapshot, type, interactionId);
  }

  private load(id: string): AgentSnapshot { return this.snapshots.load(id); }
  private save(snapshot: AgentSnapshot): AgentSnapshot { return this.snapshots.save(snapshot); }
  private event(snapshot: AgentSnapshot, type: AgentEvent["type"], content: string, data?: Record<string, unknown>, runId?: string): void {
    this.snapshots.event(snapshot, type, content, data, runId);
  }
  private result(snapshot: AgentSnapshot, toolCallId: string, content: string, data?: Record<string, unknown>, runId?: string): void {
    this.snapshots.result(snapshot, toolCallId, content, data, runId);
  }
  private run(status: AgentRunStatus): AgentRun { return this.snapshots.newRun(status); }
  private touch(run: AgentRun): void { this.snapshots.touch(run); }
  private running(snapshot: AgentSnapshot): void { this.snapshots.running(snapshot); }
  private waiting(snapshot: AgentSnapshot, status: "waiting_input" | "waiting_approval"): void { this.snapshots.waiting(snapshot, status); }
  private pauseRun(snapshot: AgentSnapshot, content: string): void { this.snapshots.pause(snapshot, content); }
  private terminal(status: AgentRunStatus): boolean { return this.snapshots.terminal(status); }
  private async intent(id: string): Promise<string> {
    const product = await this.deps.productFingerprint?.(id) ?? "local";
    return `${product}:${this.id()}`;
  }

  private async command<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.commandTails.get(id) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.commandTails.set(id, tail);
    await previous;
    try { return await operation(); }
    finally { release(); if (this.commandTails.get(id) === tail) this.commandTails.delete(id); }
  }
}

// `hasSyntheticNoopApproval` 在 getCommand 中通过 imports 引入；core.ts 不直接使用，
// 但下游会依赖它作为 AgentCore 内部逻辑的一部分，保留 re-export 以避免破坏现有 import 路径。
export { hasSyntheticNoopApproval };
