import type { AgentApproval, AgentSnapshot } from "../../shared/contracts.js";
import type { AgentSnapshotManager } from "./core-snapshot.js";
import type { AgentCoreDependencies } from "./types.js";

/** Only a direct full-entry request can invalidate the completed-run shortcut. */
export function isFullWorkflowReplayInstruction(content: string): boolean {
  const text = content.trim();
  if (/[？?]$/.test(text) || /(?:不要|不用|无需|别).{0,8}(?:重新|重跑|再录入)/u.test(text)) return false;
  if (/(?:只|仅).{0,8}(?:基础信息|图文|行程|价格|酒店|用车|条款|阶段)/u.test(text)) return false;
  const changes = text.replace(/(?:不要|不用|无需|不).{0,3}(?:修改|调整|替换|变更|重新生成)/gu, "");
  if (/修改|调整|改成|改为|替换|增加|删除|变更|生成/u.test(changes)) return false;
  return /(?:重新|重跑|再).{0,8}(?:录入|执行)/u.test(text)
    && /VBK|录入/u.test(text)
    && /完整|全部|所有阶段|从基础信息|再录入一次/u.test(text);
}

export function requestsFreshAutomationRun(approval: AgentApproval, automationRunId?: string): boolean {
  return Boolean(automationRunId && approval.replayOfAutomationRunId === automationRunId);
}

export async function requestWorkflowReplay(args: {
  id: string; content: string; deps: AgentCoreDependencies; snapshots: AgentSnapshotManager;
}): Promise<AgentSnapshot | undefined> {
  const { id, content, deps, snapshots } = args;
  if (!isFullWorkflowReplayInstruction(content)) return undefined;
  const replay = await deps.prepareWorkflowReplay?.(id, content);
  if (!replay) return undefined;
  const current = snapshots.load(id);
  const stoppedFailure = current.run?.status === "paused" && replay.automationRunStatus === "failed";
  if (current.run && !snapshots.terminal(current.run.status) && !stoppedFailure) {
    throw new Error("当前任务尚未结束，不能同时从头重新录入。");
  }
  if (current.uncertainWrite) throw new Error("上次写入结果尚未核对，不能重新录入。");
  const blocker = await deps.approvalPrecondition?.(id, replay.scope);
  if (blocker) throw new Error(`重新录入前检查未通过：${blocker}`);
  const identity = await deps.accountFor(id);
  snapshots.cancelPendingInteraction(current, "新的完整录入请求已替代旧交互。");
  current.run = snapshots.newRun("queued");
  current.run.intentVersion = `${identity.productVersion}:${current.run.id}`;
  snapshots.event(current, "user", content, { fullWorkflowReplay: true });
  snapshots.createApproval(current, replay.scope, replay.summary, identity);
  current.pendingApproval!.replayOfAutomationRunId = replay.automationRunId;
  return snapshots.save(current);
}
