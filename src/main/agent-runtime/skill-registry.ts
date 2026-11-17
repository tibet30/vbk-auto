/**
 * Skill 注册表：预装能力的元数据、Schema 与风险声明。
 *
 * 模型只能看到这里注册过的工具定义；运行期解析动作也走同一个表，
 * 因此"模型能调用的"和"运行时认识的"不会出现两份事实。
 */

import type { AgentSkillSummary } from "../../shared/contracts-agent-runtime.js";
import type { AgentToolDefinition } from "../agent/types.js";
import type { AgentSkill, AgentSkillAction } from "./types.js";

export interface ResolvedSkillAction {
  skill: AgentSkill;
  action: AgentSkillAction;
}

export class AgentSkillRegistry {
  private readonly byId = new Map<string, AgentSkill>();
  private readonly byToolName = new Map<string, ResolvedSkillAction>();

  constructor(skills: readonly AgentSkill[]) {
    for (const skill of skills) {
      if (this.byId.has(skill.id)) throw new Error(`Skill 重复注册：${skill.id}`);
      this.byId.set(skill.id, skill);
      for (const action of skill.actions) {
        if (this.byToolName.has(action.name)) throw new Error(`工具名重复注册：${action.name}`);
        this.byToolName.set(action.name, { skill, action });
      }
    }
  }

  list(): AgentSkill[] {
    return [...this.byId.values()];
  }

  get(id: string): AgentSkill | undefined {
    return this.byId.get(id);
  }

  findAction(toolName: string): ResolvedSkillAction | undefined {
    return this.byToolName.get(toolName);
  }

  /** 发给模型的工具定义；不暴露执行函数与内部风险细节。 */
  definitions(): AgentToolDefinition[] {
    return [...this.byToolName.values()].map(({ action }) => ({
      name: action.name,
      description: action.description,
      parameters: action.parameters,
      ...(action.kind === "read" ? {} : { write: true }),
    }));
  }

  summaries(): AgentSkillSummary[] {
    return this.list().map((skill) => ({
      id: skill.id,
      label: skill.label,
      description: skill.description,
      actions: skill.actions.map((action) => ({ name: action.name, label: action.label, kind: action.kind })),
    }));
  }
}
