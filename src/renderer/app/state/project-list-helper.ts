import type { ProjectSummary } from "../../../shared/contracts-types.js";

/**
 * 用 updated 替换列表中同 id 的项并移到首位。
 * 若列表中不存在该 id，返回原数组引用（不插入已删除/迟到的项）。
 */
export function upsertProjectToTop(
  projects: ProjectSummary[],
  updated: ProjectSummary,
): ProjectSummary[] {
  const idx = projects.findIndex((p) => p.id === updated.id);
  if (idx === -1) return projects;
  return [updated, ...projects.slice(0, idx), ...projects.slice(idx + 1)];
}
