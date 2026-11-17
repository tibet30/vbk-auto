/**
 * 权限策略：目录、动作、目标与授权时效的唯一判定点。
 *
 * 规则：
 *  - 读取动作在目录范围内静默执行（审计由收据承担），无需审批；
 *  - 写入与删除默认必须审批；
 *  - 已批准授权分两种作用域：`once` 只覆盖该次工具调用；`thread` 覆盖本任务内
 *    授权目录下同类动作，目录变更或撤销后立即失效；
 *  - 策略只看结构化的 `AgentActionTarget`，不读模型措辞。
 */

import type {
  AgentActionKind,
  AgentActionRisk,
  AgentPermissionGrant,
} from "../../shared/contracts-agent-runtime.js";
import { isPathInside } from "./path-scope.js";
import type { AgentActionTarget } from "./types.js";

export interface PermissionDecision {
  /** 是否允许执行（读取也要在授权目录内，越界已在 target() 阶段抛错）。 */
  allowed: boolean;
  requiresApproval: boolean;
  action: string;
  targetKey: string;
  accountKey: string;
  risk: AgentActionRisk;
  matchedGrantId?: string;
  reason?: string;
}

export function grantCoversAction(
  grant: AgentPermissionGrant,
  input: { action: string; targetKey: string; toolCallId: string },
): boolean {
  if (grant.revokedAt) return false;
  if (grant.action !== input.action) return false;
  if (grant.scope === "once") {
    return grant.toolCallId === input.toolCallId && grant.targetKey === input.targetKey;
  }
  return isPathInside(grant.targetKey, input.targetKey);
}

export function evaluatePermission(input: {
  kind: AgentActionKind;
  target: AgentActionTarget;
  grants: readonly AgentPermissionGrant[];
  toolCallId: string;
}): PermissionDecision {
  const base = {
    allowed: true,
    action: input.target.action,
    targetKey: input.target.targetKey,
    accountKey: input.target.accountKey,
    risk: input.target.risk,
  };
  if (input.kind === "read") {
    return { ...base, requiresApproval: false };
  }
  const matched = input.grants.find((grant) => grantCoversAction(grant, {
    action: input.target.action,
    targetKey: input.target.targetKey,
    toolCallId: input.toolCallId,
  }));
  if (matched) {
    return {
      ...base,
      requiresApproval: false,
      matchedGrantId: matched.id,
      reason: matched.scope === "thread" ? "本任务内已授权该目录的同类动作。" : "本次动作已获授权。",
    };
  }
  return {
    ...base,
    requiresApproval: true,
    reason: input.kind === "delete" ? "删除动作需要运营确认。" : "写入动作需要运营确认。",
  };
}

/** 授权目录变化后，任何旧授权都不能继续沿用。 */
export function grantsInvalidatedByDirectoryChange(
  grants: readonly AgentPermissionGrant[],
  nextRoot: string | undefined,
): AgentPermissionGrant[] {
  return grants.filter((grant) => !grant.revokedAt
    && (grant.scope === "thread" || !nextRoot || !isPathInside(nextRoot, grant.targetKey)));
}
