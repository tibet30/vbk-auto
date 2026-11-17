/**
 * 任务级 Skill 作用域。
 *
 * `enabled` 为 undefined 表示全部启用（历史与新建任务的默认语义）；
 * 空数组表示一个都不启用——两者不能混为一谈。
 * 未知 id 会被忽略：配置里残留的旧 Skill 不应该让整轮运行失败。
 */

import { AgentSkillRegistry } from "./skill-registry.js";
import type { AgentSkill } from "./types.js";

export function scopeSkills(skills: readonly AgentSkill[], enabled: readonly string[] | undefined): AgentSkill[] {
  if (enabled === undefined) return [...skills];
  const allowed = new Set(enabled);
  return skills.filter((skill) => allowed.has(skill.id));
}

/** 按任务启用范围裁剪出注册表；未指定时直接复用全量注册表（同一实例）。 */
export function registryForScope(all: AgentSkillRegistry, enabled: readonly string[] | undefined): AgentSkillRegistry {
  if (enabled === undefined) return all;
  return new AgentSkillRegistry(scopeSkills(all.list(), enabled));
}
