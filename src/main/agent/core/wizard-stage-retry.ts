/**
 * Deterministic preparation for the two VBK wizard pages whose official
 * “下一步” APIs are known. The renderer sends an exact, generated sentence;
 * recognize only that sentence so ordinary conversation still reaches the
 * model loop instead of acquiring a write approval unexpectedly.
 */

import type { AgentApproval, AgentSnapshot } from "../../../shared/contracts.js";
import {
  parseWizardStageRetryInstruction,
  wizardStageRetryPhaseLabel,
} from "../../../shared/wizard-stage-retry.js";
import { type AgentCore, asCoreInternals } from "../core.js";

export async function requestWizardStageRetry(
  core: AgentCore,
  id: string,
  content: string,
): Promise<AgentSnapshot | undefined> {
  const phase = parseWizardStageRetryInstruction(content);
  if (!phase) return undefined;
  const c = asCoreInternals(core);
  const prepare = c.deps.prepareWizardStageRetry;
  if (!prepare) throw new Error("当前版本尚未配置 VBK 向导阶段重试，请刷新后重试。");

  const current = c.load(id);
  if (c.active.has(id) || c.scheduled.has(id) || current.run?.status === "running") {
    throw new Error("当前方案协作仍在运行，不能同时重新执行阶段。");
  }
  if (current.uncertainWrite) throw new Error("上次写入结果尚未核验，不能重新执行阶段。");

  const plan = await prepare(id, phase);
  if (!plan) throw new Error("未能确认当前 VBK 向导状态，不能重新执行阶段。");
  if (plan.phase !== phase || !Array.isArray(plan.scope) || !plan.summary.trim()) {
    throw new Error("VBK 向导阶段重试计划无效，未创建授权。");
  }
  if (typeof plan.alreadyAdvanced !== "boolean") {
    throw new Error("VBK 向导阶段状态无效，未创建授权。");
  }
  if (!plan.alreadyAdvanced && !plan.scope.length) {
    throw new Error("VBK 向导阶段重试范围无效，未创建授权。");
  }

  let identity: { accountKey: string; productVersion: string } | undefined;
  if (!plan.alreadyAdvanced) {
    const blocker = await c.deps.approvalPrecondition?.(id, plan.scope, { wizardStageRetry: phase });
    if (blocker) throw new Error(`重新执行前检查未通过：${blocker}`);
    identity = await c.deps.accountFor(id);
  }
  const intentVersion = await c.intent(id);
  const snapshot = c.load(id);
  if (snapshot.run?.status === "running" || snapshot.uncertainWrite) {
    throw new Error("当前状态已变化，不能重新执行阶段。");
  }

  c.snapshots.interruptStreaming(snapshot, "VBK 向导阶段重新执行已接管。");
  c.cancelPendingInteraction(snapshot, "VBK 向导阶段重新执行已替代此前等待中的交互。");
  snapshot.run = c.run("queued");
  snapshot.pendingInput = undefined;
  snapshot.pendingApproval = undefined;
  snapshot.run.intentVersion = intentVersion;
  snapshot.run.error = undefined;
  c.event(snapshot, "user", content, {
    wizardStageRetry: { phase, alreadyAdvanced: plan.alreadyAdvanced },
  });
  if (plan.alreadyAdvanced) {
    c.event(snapshot, "assistant", plan.summary, {
      wizardStageRetry: { phase, alreadyAdvanced: true, readOnly: true },
    });
    c.event(snapshot, "status", `已只读确认 VBK 已越过${wizardStageRetryPhaseLabel(phase)}；不重复调用下一步。`, {
      wizardStageRetry: { phase, alreadyAdvanced: true, readOnly: true },
    });
    c.snapshots.finish(snapshot, true);
    return c.save(snapshot);
  }

  c.snapshots.createApproval(snapshot, plan.scope, plan.summary, identity!);
  const approval = snapshot.pendingApproval as AgentApproval | undefined;
  if (!approval) throw new Error("VBK 向导阶段重试授权无效，未创建授权。");
  approval.wizardStageRetry = { phase, alreadyAdvanced: plan.alreadyAdvanced };
  c.event(snapshot, "status", `已完成${wizardStageRetryPhaseLabel(phase)}重试准备；请确认后按官方下一步接口执行。`, {
    wizardStageRetry: { phase, alreadyAdvanced: plan.alreadyAdvanced },
  });
  return c.save(snapshot);
}
