/**
 * AgentCore.send 实现：用户发消息后的完整流转。
 * 抽出来纯粹为了过 AGENTS.md §1 文件行数硬上限；调用方仍是 AgentCore。
 */

import { isPendingApprovalStatusFollowup, preservesApprovedIntent } from "../approval-intent.js";
import { requestWorkflowReplay } from "../core-workflow-replay.js";
import { isPreparationStatusQuery, preparationStatusReply } from "../preparation-status-query.js";
import { isPreparationRun } from "../preparation-run.js";
import { mustIsolateApprovedRun } from "../core-preparation-resume.js";
import type { AgentSnapshot } from "../../../shared/contracts.js";
import { type AgentCore, asCoreInternals } from "../core.js";

export async function sendCommand(core: AgentCore, id: string, content: string): Promise<AgentSnapshot> {
  const c = asCoreInternals(core);
  return c.command(id, async () => {
    const text = content.trim();
    if (!text) return c.load(id);
    const replay = await requestWorkflowReplay({ id, content: text, deps: c.deps, snapshots: c.snapshots });
    if (replay) return replay;
    let snapshot = c.load(id);
    if (!c.active.has(id) && !c.scheduled.has(id)) c.snapshots.recoverInterruptedCalls(snapshot);
    if (snapshot.pendingApproval && isPendingApprovalStatusFollowup(text)) {
      const precondition = await c.deps.approvalPrecondition?.(id, snapshot.pendingApproval.scope);
      snapshot = c.load(id);
      if (!precondition && snapshot.pendingApproval) {
        c.snapshots.interruptStreaming(snapshot, "已收到对待处理状态的追问。");
        c.event(snapshot, "user", text, { pendingApprovalRetained: true });
        c.event(snapshot, "assistant", "当前方案已通过本地校验，原最终确认仍有效；无需重新生成推荐理由或重新申请确认。", {
          pendingApprovalRetained: true,
        });
        c.waiting(snapshot, "waiting_approval");
        return c.save(snapshot);
      }
      // Plan is no longer phase-A ready: drop the stale card and continue as a
      // normal turn so the model can finish local prep before re-requesting.
    }
    if (isPreparationRun(snapshot) && isPreparationStatusQuery(text)) {
      c.event(snapshot, "user", text, { readOnlyStatusQuery: true });
      c.event(snapshot, "assistant", preparationStatusReply(snapshot, c.deps.preparationProduct?.(id)), { readOnlyStatusQuery: true });
      return c.save(snapshot);
    }
    await c.deps.prepareUserInstruction?.(id, text);
    const recoveryInstruction = preservesApprovedIntent(text);
    let approved = c.snapshots.validApproval(snapshot);
    if (recoveryInstruction) approved = await c.handoffs.recover(id, snapshot) ?? approved;
    const preserveIntent = recoveryInstruction && Boolean(approved);
    const intentVersion = preserveIntent ? snapshot.run!.intentVersion : await c.intent(id);
    const isolatesApprovedRun = !recoveryInstruction && mustIsolateApprovedRun(
      snapshot,
      approved,
      c.deps.preparationProduct?.(id),
      c.handoffs.has(id),
    );
    c.snapshots.interruptStreaming(snapshot, "已由新的要求中止。");
    c.cancelPendingInteraction(snapshot, "新请求已替代此前等待中的交互。");
    const startsNewRun = !snapshot.run || c.terminal(snapshot.run.status) || isolatesApprovedRun;
    if (startsNewRun) {
      snapshot = { ...snapshot, run: c.run("queued"), pendingInput: undefined, pendingApproval: undefined };
    }
    snapshot.run!.intentVersion = intentVersion;
    snapshot.run!.error = undefined;
    if (startsNewRun && preserveIntent && approved) {
      c.event(snapshot, "approval", "已复用既有授权", {
        approval: approved,
        recoveredApproval: true,
      });
    }
    c.event(snapshot, "user", text, preserveIntent ? { approvalPreservingRecovery: true }
      : (isolatesApprovedRun ? { isolatedFromApprovedRun: true } : undefined));
    if (snapshot.uncertainWrite) c.pauseRun(snapshot, "写入结果尚未权威核对；已保存新要求，核对后才能继续。");
    else c.running(snapshot);
    const saved = c.save(snapshot);
    if (saved.run?.status !== "running") return saved;
    if (preserveIntent && approved && c.handoffs.isDeterministic(approved)) {
      await c.handoffs.refreshFingerprint(id, approved);
      const ready = c.snapshots.validApproval(c.load(id)) ?? approved;
      if (c.handoffs.tryStart(id, ready)) return c.load(id);
      const paused = c.load(id);
      c.pauseRun(paused, "已确认方案的自动录入未能重新启动；请再次点击继续执行，不会改回 AI 规划。");
      return c.save(paused);
    }
    if (!(preserveIntent && approved && c.handoffs.tryStart(id, approved))) c.loop.schedule(id);
    return c.load(id);
  });
}
