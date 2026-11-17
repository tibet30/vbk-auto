/**
 * 动作执行器：写锁、幂等执行、操作收据与不确定结果核查。
 *
 * 不变量：
 *  - 同一账号（`accountKey`）的写动作串行进入执行区，不同账号可并行；
 *  - 同一 `idempotencyKey` 永远只产生一张收据，重复提交返回既有事实；
 *  - 收据是唯一"实际发生了什么"的来源，执行失败也要留下负向收据；
 *  - 结果不确定时先回读核查，核查不了就停在 `uncertain`，禁止盲目重试。
 */

import { randomUUID } from "node:crypto";
import type {
  AgentActionReceipt,
  AgentArtifact,
  AgentToolCallRecord,
} from "../../shared/contracts-agent-runtime.js";
import type { VbkDatabase } from "../infrastructure/database/database.js";
import type { AgentSkillRegistry } from "./skill-registry.js";
import { AgentUncertainActionError, type AgentActionTarget, type AgentSkillAction, type AgentSkillContext } from "./types.js";

export interface ExecuteActionInput {
  ownerUserId: number;
  threadId: string;
  runId: string;
  action: AgentSkillAction;
  args: Record<string, unknown>;
  target: AgentActionTarget;
  context: AgentSkillContext;
  toolCall: AgentToolCallRecord;
}

export interface ExecuteActionOutcome {
  receipt: AgentActionReceipt;
  /** 回给模型的工具结果正文。 */
  content: string;
  /** 命中既有幂等收据时为 true，表示本次没有再次写入。 */
  deduplicated: boolean;
}

interface QueueState {
  /** 展示用的账号键（不带 owner 前缀）。 */
  accountKey: string;
  running: boolean;
  waiting: number;
  since?: string;
  holderThreadId?: string;
}

export class ActionExecutor {
  private readonly queues = new Map<string, Promise<unknown>>();
  /** 队列状态只用于诊断与展示，不参与调度判定。 */
  private readonly states = new Map<string, QueueState>();

  constructor(
    private readonly db: VbkDatabase,
    private readonly registry: AgentSkillRegistry,
  ) {}

  /** 同账号串行、跨账号并行；队列为空后自动回收，避免泄漏。 */
  private async serialize<T>(
    key: string,
    task: () => Promise<T>,
    meta: { threadId?: string; accountKey: string },
  ): Promise<T> {
    const state = this.states.get(key) ?? { accountKey: meta.accountKey, running: false, waiting: 0 };
    state.waiting += 1;
    this.states.set(key, state);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      state.waiting = Math.max(0, state.waiting - 1);
      state.running = true;
      state.since = new Date().toISOString();
      if (meta.threadId) state.holderThreadId = meta.threadId;
      this.states.set(key, state);
      try {
        return await task();
      } finally {
        state.running = false;
        state.since = undefined;
        state.holderThreadId = undefined;
        if (state.waiting <= 0) this.states.delete(key);
        else this.states.set(key, state);
      }
    });
    this.queues.set(key, next);
    try {
      return await next;
    } finally {
      if (this.queues.get(key) === next) this.queues.delete(key);
    }
  }

  /** 供面板展示的写队列快照；只包含非空队列。 */
  queueStates(): Array<{
    accountKey: string;
    running: boolean;
    waiting: number;
    since?: string;
    holderThreadId?: string;
  }> {
    return [...this.states.entries()]
      .filter(([, state]) => state.running || state.waiting > 0)
      .map(([, state]) => ({
        accountKey: state.accountKey,
        running: state.running,
        waiting: state.waiting,
        ...(state.since ? { since: state.since } : {}),
        ...(state.holderThreadId ? { holderThreadId: state.holderThreadId } : {}),
      }));
  }

  async execute(input: ExecuteActionInput): Promise<ExecuteActionOutcome> {
    return this.serialize(`${input.ownerUserId}:${input.target.accountKey}`, async () => {
      const existing = this.db.findAgentActionReceiptByIdempotencyKey(input.toolCall.idempotencyKey);
      if (existing) return { receipt: existing, content: receiptContent(existing), deduplicated: true };

      this.db.updateAgentToolCall(input.ownerUserId, input.toolCall.id, { status: "executing" });
      try {
        const result = await input.action.execute(input.args, input.context);
        return this.persist(input, {
          status: "succeeded",
          summary: result.summary,
          result: result.result,
          ...(result.before !== undefined ? { before: result.before } : {}),
          ...(result.detail !== undefined ? { detail: result.detail } : {}),
          ...(result.artifact ? { artifact: result.artifact } : {}),
          content: result.content,
        });
      } catch (error) {
        return this.recover(input, error);
      }
    }, { threadId: input.threadId, accountKey: input.target.accountKey });
  }

  /** 失败后先尝试回读核查，再决定收据是 fails 还是 uncertain。 */
  private async recover(input: ExecuteActionInput, error: unknown): Promise<ExecuteActionOutcome> {
    const message = error instanceof Error ? error.message : String(error);
    if (input.action.reconcile) {
      try {
        const check = await input.action.reconcile(input.args, input.context);
        return this.persist(input, {
          status: check.landed ? "succeeded" : "failed",
          summary: check.landed ? "动作经回读核查确认已落地。" : `动作失败：${message}`,
          // 未落地时必须保留原始错误：核查只说明"没写进去"，不说明"为什么没写进去"。
          result: check.landed ? `核查结果：${check.detail}` : `失败：${message}｜核查：${check.detail}`,
          detail: `核查：${check.detail}`,
          content: check.landed ? `动作已执行（经回读核查确认）：${check.detail}` : `动作未执行：${message}`,
        });
      } catch {
        // 核查本身失败时继续落到 uncertain，不允许猜成功。
      }
    }
    if (error instanceof AgentUncertainActionError || input.action.reconcile) {
      return this.persist(input, {
        status: "uncertain",
        summary: "动作结果不确定，需核查后才能重试。",
        result: message,
        detail: message,
        content: `动作结果不确定：${message}。禁止直接重试，需先核查。`,
      });
    }
    return this.persist(input, {
      status: "failed",
      summary: `动作失败：${message}`,
      result: message,
      content: `动作失败：${message}`,
    });
  }

  private persist(
    input: ExecuteActionInput,
    outcome: {
      status: "succeeded" | "failed" | "uncertain";
      summary: string;
      result: string;
      before?: string;
      detail?: string;
      artifact?: AgentArtifact;
      content: string;
    },
  ): ExecuteActionOutcome {
    const saved = this.db.saveAgentActionReceipt(input.ownerUserId, {
      threadId: input.threadId,
      runId: input.runId,
      toolCallId: input.toolCall.id,
      action: input.target.action,
      targetKey: input.target.targetKey,
      accountKey: input.target.accountKey,
      idempotencyKey: input.toolCall.idempotencyKey,
      status: outcome.status,
      result: outcome.result,
      ...(outcome.before !== undefined ? { before: outcome.before } : {}),
      ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
      ...(outcome.artifact ? { artifact: outcome.artifact } : {}),
    });
    this.db.updateAgentToolCall(input.ownerUserId, input.toolCall.id, {
      status: outcome.status,
      receiptId: saved.receipt.id,
      summary: outcome.summary,
      ...(outcome.status === "failed" || outcome.status === "uncertain" ? { error: outcome.result } : {}),
    });
    return { receipt: saved.receipt, content: outcome.content, deduplicated: !saved.created };
  }

  /**
   * 不确定写入的核查入口：只读回读，收敛为 succeeded / failed。
   * 核查仍无法判定时保持 uncertain，并把原因写进收据。
   */
  async reconcile(input: {
    ownerUserId: number;
    threadId: string;
    runId: string;
    toolCallId: string;
    context: AgentSkillContext;
  }): Promise<ExecuteActionOutcome> {
    const toolCall = this.db.getAgentToolCall(input.ownerUserId, input.toolCallId);
    if (!toolCall) throw new Error(`智能体工具调用不存在：${input.toolCallId}`);
    const route = this.registry.findAction(toolCall.toolName);
    if (!route) throw new Error(`工具未注册，无法核查：${toolCall.toolName}`);
    const receipt = toolCall.receiptId
      ? this.db.getAgentActionReceipt(input.ownerUserId, toolCall.receiptId)
      : undefined;
    if (!receipt) throw new Error("该动作没有收据，无法核查。");
    if (receipt.status !== "uncertain") {
      return { receipt, content: receiptContent(receipt), deduplicated: true };
    }
    if (!route.action.reconcile) throw new Error("该工具不支持回读核查。");

    const check = await route.action.reconcile(toolCall.arguments, input.context);
    const updated = this.db.markAgentActionReceiptReconciled(input.ownerUserId, receipt.id, {
      status: check.landed ? "succeeded" : "failed",
      detail: `核查：${check.detail}`,
    });
    this.db.updateAgentToolCall(input.ownerUserId, toolCall.id, {
      status: updated.status,
      error: check.landed ? null : check.detail,
      summary: check.landed ? "动作经回读核查确认已落地。" : `核查确认动作未落地：${check.detail}`,
    });
    return {
      receipt: updated,
      content: check.landed ? `动作已执行（核查确认）：${check.detail}` : `动作未执行：${check.detail}`,
      deduplicated: false,
    };
  }
}

function receiptContent(receipt: AgentActionReceipt): string {
  if (receipt.status === "succeeded") return receipt.result;
  if (receipt.status === "uncertain") return `动作结果不确定：${receipt.result}。禁止直接重试，需先核查。`;
  return `动作失败：${receipt.result}`;
}

/** 生成工具调用的幂等键：同一次运行中的同一模型调用只对应一次外部写入。 */
export function toolCallIdempotencyKey(runId: string, modelToolCallId: string): string {
  return `${runId}:${modelToolCallId || randomUUID()}`;
}
