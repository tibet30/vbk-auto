/**
 * 后台域写动作的准入守卫。
 *
 * 交接文档要求"每次写入有前置状态、结果和核查收据"。只读动作无所谓，
 * 但**后台写动作必须自带 `preview`（让运营看见将发送什么）与 `reconcile`
 * （执行后回读核对）**——否则一次超时或半截失败就只能记 failed，无法判断
 * 外部到底有没有发生，这正是最危险的情况。
 *
 * 只约束内置后台域（技能 id 以 `vbk` 开头）；外部 MCP 工具由各自 server 负责，
 * 不在这里替它们加无法满足的约束。
 */

import type { AgentSkill } from "../types.js";

/** 需要遵守后台写准入的技能 id 前缀。 */
const BACKEND_SKILL_PREFIXES = ["vbk"];

export function isBackendSkill(skill: AgentSkill): boolean {
  return BACKEND_SKILL_PREFIXES.some((prefix) => skill.id.startsWith(prefix));
}

export interface BackendWriteViolation {
  skillId: string;
  action: string;
  reason: string;
}

export function findBackendWriteViolations(skills: readonly AgentSkill[]): BackendWriteViolation[] {
  const violations: BackendWriteViolation[] = [];
  for (const skill of skills) {
    if (!isBackendSkill(skill)) continue;
    for (const action of skill.actions) {
      if (action.kind === "read") continue;
      if (typeof action.preview !== "function") {
        violations.push({ skillId: skill.id, action: action.name, reason: "缺少 preview：运营看不到将要发送的内容" });
      }
      if (typeof action.reconcile !== "function") {
        violations.push({ skillId: skill.id, action: action.name, reason: "缺少 reconcile：执行后无法回读核对" });
      }
    }
  }
  return violations;
}

export function assertBackendWritesAreVerifiable(skills: readonly AgentSkill[]): void {
  const violations = findBackendWriteViolations(skills);
  if (!violations.length) return;
  const detail = violations.map((entry) => `${entry.skillId}.${entry.action}：${entry.reason}`).join("；");
  throw new Error(`后台写动作未满足准入要求：${detail}`);
}
