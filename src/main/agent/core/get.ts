/**
 * AgentCore.get / reconcilePendingInput 实现：
 *   - get：拉取 snapshot 并做 detach 检测 → 中断恢复 → approval 失效检测 → pending input 刷新 → 保存
 *   - reconcilePendingInput：仅刷新 pending input（产品编辑后让旧 snapshot 上的问题重新过一遍）
 *
 * 抽出来纯粹为了过 AGENTS.md §1 文件行数硬上限；调用方仍是 AgentCore。
 * `core` 通过 `asCoreInternals` 拿到 private 字段（包内 friend 约定）。
 */

import { recoverPrematureCompletion } from "../core-completion-recovery.js";
import { refreshPendingInput } from "../core-pending-input.js";
import { hasSyntheticNoopApproval } from "../core-snapshot.js";
import {
  externalAgentActionsBlocked,
  isRecoverableSafeStartupIdentityFailure,
  SAFE_STARTUP_EXTERNAL_ACTION_BLOCK_REASON,
} from "../safe-startup-agent-guard.js";
import type { AgentApproval, AgentSnapshot } from "../../../shared/contracts.js";
import { type AgentCore, asCoreInternals } from "../core.js";

function invalidateApprovalsForSafeStartupRecovery(snapshot: AgentSnapshot): void {
  snapshot.pendingApproval = undefined;
  for (const event of snapshot.events) {
    const approval = event.data?.approval as AgentApproval | undefined;
    if (!approval || !["approved", "pending"].includes(approval.status)) continue;
    event.data = {
      ...event.data,
      approval: { ...approval, status: "invalidated" },
      safeStartupRequiresNewApproval: true,
    };
  }
}

export async function getSnapshot(core: AgentCore, id: string): Promise<AgentSnapshot> {
  const c = asCoreInternals(core);
  return c.command(id, async () => {
    const snapshot = c.load(id);
    if (externalAgentActionsBlocked(c.deps.externalAgentActionsEnabled)
      && c.deps.safeStartupLocalPreparationReady?.(id) === true
      && isRecoverableSafeStartupIdentityFailure(snapshot)) {
      invalidateApprovalsForSafeStartupRecovery(snapshot);
      snapshot.run!.error = undefined;
      c.pauseRun(snapshot, SAFE_STARTUP_EXTERNAL_ACTION_BLOCK_REASON);
      const status = snapshot.events.at(-1);
      if (status?.type === "status") status.data = {
        ...status.data,
        safeStartupIdentityRecovery: true,
        safeStartupRequiresNewApproval: true,
        preDispatchIdentityFailure: true,
      };
      return c.save(snapshot);
    }
    if (snapshot.pendingApproval?.status === 'invalidated') {
      c.cancelPendingInteraction(snapshot, '历史最终确认已失效，请按当前方案重新确认。');
    }
    const detached = !c.active.has(id) && !c.scheduled.has(id);
    if (detached) recoverPrematureCompletion(id, snapshot, c.deps, c.snapshots);
    // `handoffApprovedWorkflow` is deliberately detached from the model
    // turn. Renderer polling must not mistake that short interval for an
    // application restart and pause the freshly authorised first phase.
    const handingOff = c.handoffs.has(id);
    if (detached && !handingOff) c.snapshots.recoverInterruptedCalls(snapshot);
    if (detached && !handingOff) c.snapshots.interruptStreaming(snapshot, "应用中断，回复未完成。");
    if (snapshot.run?.status === "running" && detached && !handingOff) {
      c.pauseRun(snapshot, "应用重启后已在安全检查点暂停。");
    }
    if (hasSyntheticNoopApproval(snapshot) && !c.deps.requiresCompletionVerification?.(id, snapshot)) {
      c.cancelPendingInteraction(snapshot, "已清除由未生效操作产生的错误确认请求。");
      c.snapshots.finish(snapshot);
      return c.save(snapshot);
    }
    if (snapshot.pendingApproval?.status === "pending") {
      const blocker = await c.deps.approvalPrecondition?.(id, snapshot.pendingApproval.scope, {
        wizardStageRetry: snapshot.pendingApproval.wizardStageRetry?.phase,
      });
      if (blocker) {
        c.cancelPendingInteraction(snapshot, `最终确认已失效：${blocker}`);
        if (snapshot.run && !c.terminal(snapshot.run.status)) {
          c.pauseRun(snapshot, `最终确认已失效：${blocker}。请继续执行，系统会从缺失项自动修复。`);
        }
      }
    }
    const refresh = c.refreshPendingInput(id, snapshot);
    const saved = c.save(snapshot);
    if (refresh.shouldSchedule) c.loop.schedule(id);
    return saved;
  });
}

/** A product edit can satisfy questions that were asked from an older snapshot. */
export async function reconcilePendingInput(core: AgentCore, id: string): Promise<AgentSnapshot> {
  const c = asCoreInternals(core);
  return c.command(id, async () => {
    const snapshot = c.load(id);
    const refresh = c.refreshPendingInput(id, snapshot);
    if (!refresh.changed) return snapshot;
    const saved = c.save(snapshot);
    if (refresh.shouldSchedule) c.loop.schedule(id);
    return saved;
  });
}
