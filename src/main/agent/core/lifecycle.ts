/**
 * AgentCore 生命周期：pause / resume / abandon。
 * 抽出来纯粹为了过 AGENTS.md §1 文件行数硬上限；调用方仍是 AgentCore。
 */

import { isPreparationRun } from "../preparation-run.js";
import { canResumeLocalPreparation } from "../core-preparation-resume.js";
import type { AgentSnapshot } from "../../../shared/contracts.js";
import { type AgentCore, asCoreInternals } from "../core.js";

export async function pauseCommand(core: AgentCore, id: string): Promise<AgentSnapshot> {
  const c = asCoreInternals(core);
  return c.command(id, async () => {
    const snapshot = c.load(id);
    c.snapshots.interruptStreaming(snapshot, "已暂停，回复未完成。");
    if (snapshot.run && !c.terminal(snapshot.run.status)) c.pauseRun(snapshot, "运行已暂停");
    return c.save(snapshot);
  });
}

export async function resumeCommand(core: AgentCore, id: string): Promise<AgentSnapshot> {
  const c = asCoreInternals(core);
  return c.command(id, async () => {
    let snapshot = c.load(id);
    if (!c.active.has(id) && !c.scheduled.has(id)) c.snapshots.recoverInterruptedCalls(snapshot);
    if (!snapshot.run || ["completed", "abandoned"].includes(snapshot.run.status)) return snapshot;
    const refresh = c.refreshPendingInput(id, snapshot);
    if (refresh.changed) {
      const saved = c.save(snapshot);
      if (refresh.shouldSchedule) c.loop.schedule(id);
      return saved;
    }
    const openRetryWindow = snapshot.run.status === "paused";
    if (snapshot.pendingInput) { c.waiting(snapshot, "waiting_input"); return c.save(snapshot); }
    if (snapshot.pendingApproval) {
      const blocker = await c.deps.approvalPrecondition?.(id, snapshot.pendingApproval.scope);
      snapshot = c.load(id);
      if (!snapshot.pendingApproval) return snapshot;
      if (!blocker) {
        c.waiting(snapshot, "waiting_approval");
        return c.save(snapshot);
      }
      c.cancelPendingInteraction(snapshot, `最终确认已失效：${blocker}`);
      c.event(snapshot, "status", `最终确认已失效：${blocker}。继续从缺失项自动修复。`, {
        noProgressBlocker: "approval_precondition",
      });
    }
    if (snapshot.uncertainWrite) {
      const uncertain = structuredClone(snapshot.uncertainWrite);
      const reconciliation = await c.deps.reconcileUncertainWrite?.(id, uncertain);
      snapshot = c.load(id);
      if (!snapshot.uncertainWrite || snapshot.uncertainWrite.toolCallId !== uncertain.toolCallId) return snapshot;
      if (!reconciliation?.reconciled && !reconciliation?.retryable) {
        c.pauseRun(snapshot, reconciliation?.message ?? "写入结果尚未权威核对，不能继续。");
        return c.save(snapshot);
      }
      if (reconciliation.retryable) {
        snapshot.uncertainWrite = undefined;
        c.event(snapshot, "status", reconciliation.message ?? "已确认上一轮未形成可验证写入，可定向重试。", { retryable: true });
      } else {
        const message = reconciliation.message ?? "不确定写入已核对。";
        c.snapshots.reconcileCall(snapshot, uncertain.toolCallId, message);
        snapshot.uncertainWrite = undefined;
        c.event(snapshot, "status", message, { reconciled: true, toolCallId: uncertain.toolCallId });
      }
    }
    // The recovery button is an operational retry, so recover prior approval first.
    await c.handoffs.recover(id, snapshot);
    const preparationRetry = openRetryWindow && isPreparationRun(snapshot) && canResumeLocalPreparation(snapshot, Boolean(c.snapshots.validApproval(snapshot)));
    if (openRetryWindow) c.snapshots.openNoProgressRetryWindow(snapshot);
    if (preparationRetry) {
      c.event(snapshot, "user", "继续当前本地规划与资源核验。", { preparationResume: true });
    }
    snapshot.run!.error = undefined;
    c.running(snapshot);
    const saved = c.save(snapshot);
    const approval = c.snapshots.validApproval(saved);
    if (approval && c.handoffs.isDeterministic(approval)) {
      // Phase B resume must never fall back to the model loop.
      await c.handoffs.refreshFingerprint(id, approval);
      const ready = c.snapshots.validApproval(c.load(id)) ?? approval;
      if (c.handoffs.tryStart(id, ready)) return c.load(id);
      const paused = c.load(id);
      c.pauseRun(paused, "已确认方案的自动录入未能重新启动；请再次点击继续执行，不会改回 AI 规划。");
      return c.save(paused);
    }
    if (!(approval && c.handoffs.tryStart(id, approval))) c.loop.schedule(id);
    return c.load(id);
  });
}

export async function abandonCommand(core: AgentCore, id: string): Promise<AgentSnapshot> {
  const c = asCoreInternals(core);
  return c.command(id, async () => {
    const snapshot = c.load(id);
    if (snapshot.run && !c.terminal(snapshot.run.status)) {
      c.snapshots.interruptStreaming(snapshot, "任务已废弃，回复未完成。");
      c.cancelPendingInteraction(snapshot, "运行已放弃。");
      snapshot.run.status = "abandoned";
      c.touch(snapshot.run);
      c.event(snapshot, "status", "运行已放弃", { status: "abandoned" });
    }
    return c.save(snapshot);
  });
}
