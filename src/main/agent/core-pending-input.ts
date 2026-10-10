import type { AgentSnapshot } from "../../shared/contracts.js";
import { isPreparationRun } from "./preparation-run.js";
import { requiredItineraryPoiSatisfaction } from "./core-preparation-poi-input.js";
import type { AgentSnapshotManager } from "./core-snapshot.js";
import type { AgentCoreDependencies } from "./types.js";
import { hotelAvailabilityQuestions } from "./core-preparation-hotel-input.js";
import { canAutomaticallyAnswerProductQuestion, isAutomaticProductInputRun } from "./automatic-product-input.js";

export interface PendingInputRefresh {
  changed: boolean;
  shouldSchedule: boolean;
}

/** Reconcile saved answers without turning a voluntary pause into an implicit retry. */
export function refreshPendingInput(args: {
  id: string;
  snapshot: AgentSnapshot;
  deps: AgentCoreDependencies;
  snapshots: AgentSnapshotManager;
}): PendingInputRefresh {
  const { id, snapshot, deps, snapshots } = args;
  const request = snapshot.pendingInput;
  if (!request) {
    const hotelRecovery = recoverPausedHotelInput(args);
    if (hotelRecovery.changed && snapshot.pendingInput) return refreshPendingInput(args);
    return hotelRecovery.changed ? hotelRecovery : resumeManualPoiBlocked(args);
  }
  if (!request.questions.length || snapshot.run?.status !== "waiting_input") {
    return { changed: false, shouldSchedule: false };
  }
  const questions = request.questions;
  const canAutomaticallyResume = isAutomaticProductInputRun(deps, snapshot) && !snapshot.uncertainWrite && !snapshot.pendingApproval
    && !hasActiveApprovedIntent(snapshot) && !hasRemoteWriteInRun(snapshot);
  if (canAutomaticallyResume && questions.every(canAutomaticallyAnswerProductQuestion)) {
    const resolved = deps.resolvedPendingQuestions?.(id, questions) ?? [];
    const answers = { ...request.defaultAnswers,
      ...Object.fromEntries(resolved.map(item => [item.id, item.answer ?? request.defaultAnswers?.[item.id] ?? "已在当前产品中保存"])) };
    const callId = snapshots.pendingCallId(snapshot, "input_request", request.id);
    if (callId) snapshots.result(snapshot, callId, `已保存答案：${JSON.stringify(answers)}。普通资料问题由 AI 自动回答，不等待运营：${JSON.stringify(questions.filter(question => !resolved.some(item => item.id === question.id)))}。请自行补齐或通过 ask_user 调用程序自动问答。`, {
      automaticInputRedirect: true, automaticallyResumed: true, resolved: true, reconciled: true, defaultAnswers: answers,
    }, snapshot.run?.id);
    snapshot.pendingInput = undefined;
    if (snapshot.run) { snapshot.run.status = "running"; snapshots.touch(snapshot.run); }
    snapshots.event(snapshot, "status", `已将历史资料输入转交 AI 自动处理：${JSON.stringify(questions)}`, { automaticInputRedirect: true }, snapshot.run?.id);
    return { changed: true, shouldSchedule: true };
  }
  const resolved = deps.resolvedPendingQuestions?.(id, questions) ?? [];
  const resolvedIds = new Set(resolved.map((item) => item.id));
  if (!resolvedIds.size) return { changed: false, shouldSchedule: false };
  const remaining = questions.filter((question) => !resolvedIds.has(question.id));
  const message = resolved.map((item) => item.message).join("；");
  if (remaining.length) {
    snapshot.pendingInput = {
      ...request,
      questions: remaining,
      defaultAnswers: {
        ...request.defaultAnswers,
        ...Object.fromEntries(resolved.map((item) => [item.id, item.answer ?? "已在当前产品中保存"])),
      },
    };
    snapshots.event(snapshot, "status", `${message}。其余问题仍需回答。`, { reconciledQuestions: [...resolvedIds] });
    return { changed: true, shouldSchedule: false };
  }

  const canResume = isPreparationRun(snapshot)
    && !snapshot.uncertainWrite
    && !snapshot.pendingApproval
    && !hasActiveApprovedIntent(snapshot)
    && !hasRemoteWriteInRun(snapshot)
    && !resolved.some((item) => item.pause);
  if (!canResume) {
    snapshots.cancelPendingInteraction(snapshot, message);
    snapshots.pause(snapshot, `${message}。旧问题已撤销，请继续当前方案。`);
    return { changed: true, shouldSchedule: false };
  }

  const callId = snapshots.pendingCallId(snapshot, "input_request", request.id);
  const resolvedAnswers = Object.fromEntries(resolved.flatMap((item) => {
    const answer = item.answer ?? request.defaultAnswers?.[item.id];
    return answer === undefined ? [] : [[item.id, answer]];
  }));
  const resultContent = Object.keys(resolvedAnswers).length ? `${JSON.stringify(resolvedAnswers)}\n${message}` : message;
  snapshot.pendingInput = undefined;
  if (callId) snapshots.result(snapshot, callId, resultContent, {
    resolved: true, reconciled: true, reconciledQuestions: [...resolvedIds], defaultAnswers: resolvedAnswers,
    automaticallyResumed: true,
  });
  snapshots.event(snapshot, "status", `${message}。已使用当前产品数据继续本地规划。`, {
    reconciledQuestions: [...resolvedIds], automaticallyResumed: true,
  });
  snapshots.running(snapshot);
  return { changed: true, shouldSchedule: true };
}

function hasActiveApprovedIntent(snapshot: AgentSnapshot): boolean {
  return snapshot.events.some((event) => event.runId === snapshot.run?.id && event.type === "approval"
    && event.data?.approval && typeof event.data.approval === "object"
    && (event.data.approval as { status?: unknown; intentVersion?: unknown }).status === "approved"
    && (event.data.approval as { intentVersion?: unknown }).intentVersion === snapshot.run?.intentVersion);
}

function hasRemoteWriteInRun(snapshot: AgentSnapshot): boolean {
  return snapshot.events.some((event) => event.runId === snapshot.run?.id && event.type === "tool_result"
    && event.data?.remoteWrite === true);
}

/** Older repeated hotel failures paused without exposing the missing decision.
 * Recover only that automatic pause, using current candidates to omit repaired nights. */
function recoverPausedHotelInput(args: {
  id: string; snapshot: AgentSnapshot; deps: AgentCoreDependencies; snapshots: AgentSnapshotManager;
}): PendingInputRefresh {
  const { id, snapshot, deps, snapshots } = args;
  const unchanged = { changed: false, shouldSchedule: false };
  if (snapshot.run?.status !== "paused" || !isPreparationRun(snapshot) || snapshot.uncertainWrite || snapshot.pendingApproval
    || hasActiveApprovedIntent(snapshot) || hasRemoteWriteInRun(snapshot)) return unchanged;
  const pause = [...snapshot.events].reverse().find(event => event.runId === snapshot.run?.id
    && event.type === "status" && event.data?.status === "paused");
  if (!pause?.content.startsWith("相同工具和参数连续失败两次")) return unchanged;
  const failure = [...snapshot.events].reverse().find(event => event.runId === snapshot.run?.id && event.type === "tool_result");
  const call = snapshot.events.find(event => event.type === "tool_call" && event.data?.toolCallId === failure?.data?.toolCallId);
  if (call?.data?.name !== "resolve_itinerary_hotels" || typeof failure?.data?.error !== "string") return unchanged;
  const product = deps.preparationProduct?.(id);
  const questions = product ? hotelAvailabilityQuestions(product, failure.data.error) : [];
  if (!questions.length) return unchanged;
  snapshots.event(snapshot, "status", `历史住宿资料问题已转交 AI 自动处理：${JSON.stringify(questions)}`, {
    automaticInputRedirect: true, recoveredHotelFailure: true, questions,
  });
  snapshots.running(snapshot);
  return { changed: true, shouldSchedule: true };
}

function resumeManualPoiBlocked(args: {
  id: string; snapshot: AgentSnapshot; deps: AgentCoreDependencies; snapshots: AgentSnapshotManager;
}): PendingInputRefresh {
  const { id, snapshot, deps, snapshots } = args;
  if (snapshot.run?.status !== "paused" || !isPreparationRun(snapshot) || snapshot.uncertainWrite || snapshot.pendingApproval
    || hasActiveApprovedIntent(snapshot) || hasRemoteWriteInRun(snapshot)) return { changed: false, shouldSchedule: false };
  const latestPause = [...snapshot.events].reverse().find((event) => event.runId === snapshot.run?.id
    && event.type === "status" && event.data?.status === "paused");
  if (latestPause?.data?.manualPoiBlocked !== true) return { changed: false, shouldSchedule: false };
  const product = deps.preparationProduct?.(id);
  const satisfaction = product ? requiredItineraryPoiSatisfaction(product) : undefined;
  if (!satisfaction?.hasRequiredPoi || !satisfaction.satisfied) return { changed: false, shouldSchedule: false };
  snapshots.running(snapshot);
  snapshots.event(snapshot, "status", "手动保存的 POI 已齐全，继续本地规划。", {
    manualPoiBlockedResolved: true, automaticallyResumed: true, poiSlotKey: latestPause.data?.poiSlotKey,
  });
  return { changed: true, shouldSchedule: true };
}
