/**
 * AgentCore 输入侧：approve / respond / repairIllegalKeywords。
 * 抽出来纯粹为了过 AGENTS.md §1 文件行数硬上限；调用方仍是 AgentCore。
 */

import { resolveSelectedAnswers } from "../selected-input-answers.js";
import { validateAnswers } from "../core-validation.js";
import type {
  AgentApproval,
  AgentApprovalResponse,
  AgentIllegalKeywordRepairInput,
  AgentInputResponse,
  AgentSnapshot,
} from "../../../shared/contracts.js";
import type { NoProgressBlocker } from "../core-snapshot.js";
import { type AgentCore, asCoreInternals } from "../core.js";

export async function approveCommand(core: AgentCore, id: string, response: AgentApprovalResponse): Promise<AgentSnapshot> {
  const c = asCoreInternals(core);
  return c.command(id, async () => {
    const pending = c.load(id).pendingApproval;
    if (!pending || pending.id !== response.approvalId || pending.productVersion !== response.productVersion) return c.load(id);
    const precondition = await c.deps.approvalPrecondition?.(id, pending.scope);
    const identity = precondition ? undefined : await c.deps.accountFor(id);
    const snapshot = c.load(id);
    const approval = snapshot.pendingApproval;
    if (!approval || !["waiting_approval", "paused"].includes(snapshot.run?.status ?? "")
      || approval.id !== response.approvalId || approval.productVersion !== response.productVersion) return snapshot;
    const toolCallId = c.pendingCallId(snapshot, "approval_request", approval.id);
    let granted: AgentApproval | undefined;
    if (precondition || !identity || approval.accountKey !== identity.accountKey || approval.productVersion !== identity.productVersion
      || approval.intentVersion !== snapshot.run?.intentVersion) {
      approval.status = "invalidated";
      snapshot.pendingApproval = undefined;
      c.event(snapshot, "approval", "授权已失效", { approval });
      const message = precondition ? `授权前置条件已变化：${precondition}` : "授权已失效，请重新申请。";
      const blocker: NoProgressBlocker = precondition ? "approval_precondition" : "authorization_denied";
      if (toolCallId) c.blockedResult(snapshot, toolCallId, message, blocker, { approvalId: approval.id });
      else c.completionBlocked(snapshot, message, blocker);
    } else {
      approval.status = "approved";
      approval.trafficRouteReviewAuthorized = response.trafficRouteReviewAuthorized === true;
      granted = approval;
      snapshot.pendingApproval = undefined;
      c.event(snapshot, "approval", "用户已授权", { approval });
      if (toolCallId) c.result(snapshot, toolCallId, "授权已确认。", { approval });
    }
    if (snapshot.run?.status !== "paused") c.running(snapshot);
    const saved = c.save(snapshot);
    if (saved.run?.status === "running" && !(granted && c.handoffs.tryStart(id, granted))) c.loop.schedule(id);
    return saved;
  });
}

export async function respondCommand(core: AgentCore, id: string, response: AgentInputResponse): Promise<AgentSnapshot> {
  const c = asCoreInternals(core);
  return c.command(id, async () => {
    const snapshot = c.load(id);
    const request = snapshot.pendingInput;
    if (!request || !["waiting_input", "paused"].includes(snapshot.run?.status ?? "")
      || request.id !== response.requestId || !validateAnswers(request, response.answers)) return snapshot;
    const resolved = resolveSelectedAnswers(request, response.answers);
    const changed = await c.deps.prepareUserInstruction?.(id, resolved.instruction, {
      selectedLabels: resolved.selectedLabels,
      selectedQuestions: resolved.selectedQuestions,
    });
    if (changed && snapshot.run) snapshot.run.intentVersion = await c.intent(id);
    snapshot.pendingInput = undefined;
    const toolCallId = c.pendingCallId(snapshot, "input_request", request.id);
    const answers = { ...(request.defaultAnswers ?? {}), ...response.answers };
    const resolvedAnswers = { ...answers, ...resolved.answers };
    if (toolCallId) c.result(snapshot, toolCallId, JSON.stringify(resolvedAnswers), { requestId: request.id, answers, resolvedAnswers });
    c.event(snapshot, "user", `用户回答：${JSON.stringify(resolvedAnswers)}`, { requestId: request.id, answers, resolvedAnswers });
    c.running(snapshot);
    const saved = c.save(snapshot);
    c.loop.schedule(id);
    return saved;
  });
}

export async function repairIllegalKeywordsCommand(core: AgentCore, id: string, input: AgentIllegalKeywordRepairInput): Promise<AgentSnapshot> {
  const c = asCoreInternals(core);
  return c.command(id, async () => {
    const text = input.content.trim();
    if (!text) return c.load(id);
    const intentVersion = await c.intent(id);
    let snapshot = c.load(id);
    if (!c.active.has(id) && !c.scheduled.has(id)) c.snapshots.recoverInterruptedCalls(snapshot);
    c.snapshots.interruptStreaming(snapshot, "已由非法关键词修复任务接管。");
    c.cancelPendingInteraction(snapshot, "非法关键词修复任务已替代此前等待中的交互。");
    if (!snapshot.run || c.terminal(snapshot.run.status)) {
      snapshot = { ...snapshot, run: c.run("queued"), pendingInput: undefined, pendingApproval: undefined };
    }
    snapshot.run!.intentVersion = intentVersion;
    snapshot.run!.error = undefined;
    c.event(snapshot, "user", text, {
      illegalKeywordRepair: true,
      keywords: input.keywords,
      affectedPaths: input.affectedPaths,
    });
    c.event(snapshot, "status", `已记录 VBK 文案黑名单：${input.keywords.join("、") || "见错误详情"}，开始重写图文。`, {
      illegalKeywordRepair: true,
      keywords: input.keywords,
      affectedPaths: input.affectedPaths,
    });
    snapshot.uncertainWrite = undefined;
    c.running(snapshot);
    const saved = c.save(snapshot);
    c.loop.schedule(id);
    return saved;
  });
}
