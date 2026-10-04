import type { AgentSnapshot } from "../../shared/contracts.js";
import { isPreparationRun } from "./preparation-run.js";
import type { AgentSnapshotManager } from "./core-snapshot.js";
import type { AgentCoreDependencies } from "./types.js";

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
  if (!request || !request.questions.length || snapshot.run?.status !== "waiting_input") {
    return { changed: false, shouldSchedule: false };
  }
  const questions = request.questions;
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
