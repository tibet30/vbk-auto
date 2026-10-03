import type { ResearchTask } from "../../../../shared/contracts.js";
import { canonicalPoiResearchTaskLabel, poiResearchTaskName } from "../../../../shared/poi-research-tasks.js";

function preferLogicalPoiTask(current: ResearchTask, candidate: ResearchTask): ResearchTask {
  const rank: Record<ResearchTask["state"], number> = {
    proposed: 0,
    researching: 1,
    blocked: 2,
    confirmed: 3,
    resolved: 4,
    needs_confirmation: 2,
  };
  return rank[candidate.state] > rank[current.state] ? candidate : current;
}

/**
 * Legacy POI rows remain untouched for auditability. Detail reads expose their
 * semantic union as one canonical task, so operators do not see duplicate work.
 */
export function coalescePoiResearchTasks(tasks: ResearchTask[]): ResearchTask[] {
  const result: ResearchTask[] = [];
  const groups = new Map<string, ResearchTask[]>();
  for (const task of tasks) {
    const name = poiResearchTaskName(task.label, task.type);
    if (!name) {
      result.push(task);
      continue;
    }
    const key = `${task.type}::${name}`;
    groups.set(key, [...(groups.get(key) ?? []), task]);
  }
  for (const group of groups.values()) {
    const primary = group.reduce(preferLogicalPoiTask);
    const detail = [...new Set(group.map((task) => task.detail).filter((value): value is string => !!value))].join("；") || undefined;
    const evidence = group.flatMap((task) => task.evidence ?? []);
    result.push({
      ...primary,
      label: canonicalPoiResearchTaskLabel(primary.label, primary.type),
      detail,
      evidence,
    });
  }
  return result;
}

