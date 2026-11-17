/**
 * 运行服务：把「线程意图」推进成可暂停、可恢复、可核查的执行事实。
 *
 * 对外只有五种操作：开始、批准、拒绝、取消、恢复；以及只读快照。
 * 右侧工作面板的状态全部来自快照，界面不允许自己发明运行状态。
 */

import type {
  AgentActionReceipt,
  AgentApprovalRequest,
  AgentApprovalScope,
  AgentRun,
  AgentRuntimeSnapshot,
  AgentToolCallRecord,
} from "../../shared/contracts-agent-runtime.js";
import type { AgentModelMessage } from "../agent/types.js";
import type { VbkDatabase } from "../infrastructure/database/database.js";
import { ActionExecutor } from "./action-executor.js";
import { isPathInside, resolveScopedPath } from "./path-scope.js";
import { advanceAgentRun, loadTranscript, saveTranscript, type AgentRunProvider } from "./run-loop.js";
import type { AgentSkillRegistry } from "./skill-registry.js";
import type { AgentActionTarget, AgentSkillContext } from "./types.js";

/** 面板回看的最近运行条数。 */
const RECENT_RUN_LIMIT = 10;

/** 每次"继续运行"追加的步数预算。 */
const RESUME_STEP_BUDGET = 8;

export interface AgentRunServiceOptions {
  db: VbkDatabase;
  registry: AgentSkillRegistry;
  executor: ActionExecutor;
}

export interface AgentRunAdvanceInput {
  ownerUserId: number;
  threadId: string;
  history: AgentModelMessage[];
  workingDirectory?: string;
  provider: () => Promise<AgentRunProvider>;
  /** 任务级作用域：默认使用装配时的全量注册表。 */
  registry?: AgentSkillRegistry;
}

interface PendingAction {
  run: AgentRun;
  toolCall: AgentToolCallRecord;
  target: AgentActionTarget;
}

function modelToolCallId(idempotencyKey: string, runId: string): string {
  return idempotencyKey.startsWith(`${runId}:`) ? idempotencyKey.slice(runId.length + 1) : "";
}

export class AgentRunService {
  constructor(private readonly options: AgentRunServiceOptions) {}

  private get db(): VbkDatabase {
    return this.options.db;
  }

  private get registry(): AgentSkillRegistry {
    return this.options.registry;
  }

  /** 每次运行的实际技能范围：任务禁用某些 Skill 时只暴露剩下的。 */
  private scopeOf(input: { registry?: AgentSkillRegistry }): AgentSkillRegistry {
    return input.registry ?? this.registry;
  }

  private get executor(): ActionExecutor {
    return this.options.executor;
  }

  private context(ownerUserId: number, threadId: string, runId: string, workingDirectory?: string): AgentSkillContext {
    return { ownerUserId, threadId, runId, ...(workingDirectory ? { workingDirectory } : {}) };
  }

  /** 开一次新运行；同一线程存在未终结运行时不允许开始第二次。 */
  async start(input: AgentRunAdvanceInput & { intent: string }): Promise<AgentRun> {
    if (this.db.findActiveAgentRun(input.ownerUserId, input.threadId)) {
      throw new Error("当前任务还有未完成的运行，请先处理待审批动作或取消本次运行。");
    }
    const run = this.db.createAgentRun(input.ownerUserId, { threadId: input.threadId, intent: input.intent });
    return this.advance(input, run);
  }

  /**
   * 从上次中断处继续：只允许 `needs_attention`。
   * `uncertain` 必须先核查、`waiting_approval` 必须先批准或拒绝，否则协议会断。
   */
  async resume(input: AgentRunAdvanceInput): Promise<AgentRun> {
    const run = this.db.findActiveAgentRun(input.ownerUserId, input.threadId);
    if (!run) throw new Error("当前任务没有可继续的运行。");
    if (run.status === "uncertain") throw new Error("动作结果不确定，请先核查结果再继续。");
    if (run.status === "waiting_approval") throw new Error("当前有待审批动作，请先批准或拒绝。");
    if (run.status !== "needs_attention") throw new Error(`当前运行状态不能继续：${run.status}`);
    const transcript = loadTranscript(this.db, input.ownerUserId, run.id);
    const last = transcript[transcript.length - 1];
    if (last?.role === "assistant" && (last.toolCalls?.length ?? 0) > 0) {
      throw new Error("还有未完成的工具调用，请先处理审批或核查。");
    }
    // 补足步数预算，否则继续后会立刻再次撞到上限。
    this.db.updateAgentRun(input.ownerUserId, run.id, { maxSteps: run.step + RESUME_STEP_BUDGET });
    return this.advance(input, run);
  }

  async approve(input: AgentRunAdvanceInput & { toolCallId: string; scope: AgentApprovalScope }): Promise<AgentRun> {
    const pending = await this.loadPending(input.ownerUserId, input.threadId, input.toolCallId, input.workingDirectory);
    this.db.createAgentPermissionGrant(input.ownerUserId, {
      threadId: input.threadId,
      runId: pending.run.id,
      toolCallId: pending.toolCall.id,
      scope: input.scope,
      action: pending.target.action,
      targetKey: await this.grantTarget(input.scope, pending.target.targetKey, input.workingDirectory),
      accountKey: pending.target.accountKey,
    });
    await this.executePending(input, pending);
    return this.advance(input, pending.run);
  }

  async reject(input: {
    ownerUserId: number;
    threadId: string;
    toolCallId: string;
    reason?: string;
    workingDirectory?: string;
  }): Promise<AgentRun> {
    const pending = await this.loadPending(input.ownerUserId, input.threadId, input.toolCallId, input.workingDirectory);
    const reason = input.reason?.trim() || "运营拒绝该动作。";
    this.db.updateAgentToolCall(input.ownerUserId, pending.toolCall.id, { status: "denied", error: reason });
    const transcript = loadTranscript(this.db, input.ownerUserId, pending.run.id);
    transcript.push({
      role: "tool",
      toolCallId: modelToolCallId(pending.toolCall.idempotencyKey, pending.run.id),
      content: `运营拒绝了这个动作：${reason}。请改用不需要该写入的方案，或向运营说明理由。`,
    });
    saveTranscript(this.db, input.ownerUserId, pending.run.id, transcript);
    this.db.addAgentThreadMessage(input.ownerUserId, input.threadId, "system", `已拒绝动作：${pending.toolCall.summary}`);
    const rejected = this.db.updateAgentRun(input.ownerUserId, pending.run.id, {
      status: "rejected",
      error: reason,
      completedAt: new Date().toISOString(),
    });
    saveTranscript(this.db, input.ownerUserId, rejected.id, []);
    return rejected;
  }

  /** 不确定写入的核查：只读回读后收敛收据，并把结论写回任务历史。 */
  async reconcile(input: {
    ownerUserId: number;
    threadId: string;
    toolCallId: string;
    workingDirectory?: string;
  }): Promise<{ toolCall: AgentToolCallRecord; receipt: AgentActionReceipt }> {
    const toolCall = this.db.getAgentToolCall(input.ownerUserId, input.toolCallId);
    if (!toolCall) throw new Error(`智能体工具调用不存在：${input.toolCallId}`);
    if (toolCall.threadId !== input.threadId) throw new Error("该动作不属于当前任务。");
    if (toolCall.status !== "uncertain") throw new Error("该动作不在待核查状态。");
    const outcome = await this.executor.reconcile({
      ownerUserId: input.ownerUserId,
      threadId: input.threadId,
      runId: toolCall.runId,
      toolCallId: toolCall.id,
      context: this.context(input.ownerUserId, input.threadId, toolCall.runId, input.workingDirectory),
    });
    const conclusion = outcome.receipt.status === "succeeded"
      ? `核查确认已落地：${outcome.receipt.result}`
      : `核查确认未落地：${outcome.receipt.result}`;
    this.db.addAgentThreadMessage(input.ownerUserId, input.threadId, "system", `不确定写入核查：${conclusion}`);
    const run = this.db.getAgentRun(input.ownerUserId, toolCall.runId);
    if (run?.status === "uncertain") {
      this.db.updateAgentRun(input.ownerUserId, run.id, { status: "needs_attention", error: conclusion });
    }
    return { toolCall: this.db.getAgentToolCall(input.ownerUserId, toolCall.id)!, receipt: outcome.receipt };
  }

  async cancel(input: { ownerUserId: number; threadId: string }): Promise<AgentRun | undefined> {    const run = this.db.findActiveAgentRun(input.ownerUserId, input.threadId);
    if (!run) return undefined;
    for (const toolCall of this.db.listAgentToolCalls(input.ownerUserId, run.id)) {
      if (toolCall.status === "awaiting_approval") {
        this.db.updateAgentToolCall(input.ownerUserId, toolCall.id, { status: "denied", error: "运行已取消。" });
      }
    }
    const cancelled = this.db.updateAgentRun(input.ownerUserId, run.id, {
      status: "cancelled",
      error: "运营取消了本次运行。",
      completedAt: new Date().toISOString(),
    });
    saveTranscript(this.db, input.ownerUserId, cancelled.id, []);
    return cancelled;
  }

  /** 应用重启后的恢复：执行中的工具调用转 uncertain，运行退回可解释状态。 */
  recoverInterrupted(): { runs: number; toolCalls: number } {
    const toolCalls = this.db.markInterruptedAgentToolCallsUncertain("应用重启打断了执行，需回读核查。");
    const runs = this.db.recoverInterruptedAgentRuns("应用重启打断了本次运行，请继续发送消息或重新提出任务。");
    return { runs, toolCalls };
  }

  snapshot(input: {
    ownerUserId: number;
    threadId: string;
    workingDirectory?: string;
    enabledSkills?: string[];
  }): AgentRuntimeSnapshot {
    const active = this.db.findActiveAgentRun(input.ownerUserId, input.threadId);
    const recentRuns = this.db.listAgentRuns(input.ownerUserId, input.threadId, RECENT_RUN_LIMIT);
    const run = active ?? recentRuns[0];
    const toolCalls = this.db.listAgentToolCallsByThread(input.ownerUserId, input.threadId, 20);
    const approval = run?.status === "waiting_approval"
      ? this.buildApproval(run, toolCalls, input.workingDirectory)
      : undefined;
    return {
      ...(run ? { run } : {}),
      ...(approval ? { approval } : {}),
      toolCalls,
      receipts: this.db.listAgentActionReceipts(input.ownerUserId, input.threadId, 20),
      // 面板要能重新启用被停用的 Skill，因此这里给全量清单 + 当前启用范围。
      skills: this.registry.summaries(),
      ...(this.executor.queueStates().length ? { writeQueues: this.executor.queueStates() } : {}),
      ...(input.enabledSkills !== undefined ? { enabledSkills: [...input.enabledSkills] } : {}),
      ...(recentRuns.length ? { runs: recentRuns } : {}),
    };
  }

  private buildApproval(
    run: AgentRun,
    toolCalls: readonly AgentToolCallRecord[],
    workingDirectory?: string,
  ): AgentApprovalRequest | undefined {
    const pending = [...toolCalls].reverse()
      .find((toolCall) => toolCall.status === "awaiting_approval" && toolCall.runId === run.id);
    if (!pending) return undefined;
    const route = this.registry.findAction(pending.toolName);
    return {
      toolCallId: pending.id,
      runId: run.id,
      skillId: pending.skillId,
      skillLabel: route?.skill.label ?? pending.skillId,
      toolName: pending.toolName,
      actionLabel: route?.action.label ?? pending.toolName,
      kind: pending.kind,
      risk: pending.risk,
      accountKey: pending.accountKey ?? pending.skillId,
      ...(workingDirectory ? { directory: workingDirectory } : {}),
      targetKey: pending.targetKey ?? "",
      summary: pending.summary,
      ...(pending.diff ? { diff: pending.diff } : {}),
      scopes: ["once", "thread"],
    };
  }

  /**
   * thread 授权的作用域：文件系统目标以授权目录为范围（覆盖同目录同类动作）；
   * 非文件系统目标（例如外部 MCP 工具）没有目录概念，只覆盖这一个目标。
   */
  private async grantTarget(
    scope: AgentApprovalScope,
    targetKey: string,
    workingDirectory?: string,
  ): Promise<string> {
    if (scope !== "thread" || !workingDirectory) return targetKey;
    const root = await resolveScopedPath(workingDirectory, ".").catch(() => undefined);
    if (!root) return targetKey;
    return isPathInside(root.root, targetKey) ? root.root : targetKey;
  }

  private async loadPending(
    ownerUserId: number,
    threadId: string,
    toolCallId: string,
    workingDirectory?: string,
    registry?: AgentSkillRegistry,
  ): Promise<PendingAction> {
    const toolCall = this.db.getAgentToolCall(ownerUserId, toolCallId);
    if (!toolCall) throw new Error(`智能体工具调用不存在：${toolCallId}`);
    // 先判断动作本身，重复批准得到的是"已经处理过"而不是含糊的运行状态错误。
    if (toolCall.status !== "awaiting_approval") throw new Error("该动作已经处理过，无需重复批准。");
    const run = this.db.findActiveAgentRun(ownerUserId, threadId);
    if (!run) throw new Error("当前任务没有进行中的运行。");
    if (run.status !== "waiting_approval") throw new Error("当前运行不在待审批状态。");
    if (toolCall.runId !== run.id) throw new Error("该动作不属于当前运行。");
    // 审批与核查按全量注册表解析：Skill 事后被停用也不能让已提出的动作失去归属。
    const route = (registry ?? this.registry).findAction(toolCall.toolName)
      ?? this.registry.findAction(toolCall.toolName);
    if (!route) throw new Error(`工具未注册：${toolCall.toolName}`);
    const context = this.context(ownerUserId, threadId, run.id, workingDirectory);
    const target = await route.action.target(toolCall.arguments, context);
    return { run, toolCall, target };
  }

  private async executePending(
    input: AgentRunAdvanceInput & { toolCallId: string },
    pending: PendingAction,
  ): Promise<void> {
    const route = this.registry.findAction(pending.toolCall.toolName);
    if (!route) throw new Error(`工具未注册：${pending.toolCall.toolName}`);
    const context = this.context(input.ownerUserId, input.threadId, pending.run.id, input.workingDirectory);
    const executed = await this.executor.execute({
      ownerUserId: input.ownerUserId,
      threadId: input.threadId,
      runId: pending.run.id,
      action: route.action,
      args: pending.toolCall.arguments,
      target: pending.target,
      context,
      toolCall: pending.toolCall,
    });
    const transcript = loadTranscript(this.db, input.ownerUserId, pending.run.id);
    transcript.push({
      role: "tool",
      toolCallId: modelToolCallId(pending.toolCall.idempotencyKey, pending.run.id),
      content: executed.content,
    });
    saveTranscript(this.db, input.ownerUserId, pending.run.id, transcript);
  }

  private async advance(input: AgentRunAdvanceInput, run: AgentRun): Promise<AgentRun> {
    const outcome = await advanceAgentRun({
      db: this.db,
      registry: this.scopeOf(input),
      executor: this.executor,
      ownerUserId: input.ownerUserId,
      threadId: input.threadId,
      runId: run.id,
      history: input.history,
      context: this.context(input.ownerUserId, input.threadId, run.id, input.workingDirectory),
      provider: input.provider,
    });
    return outcome.run;
  }
}
