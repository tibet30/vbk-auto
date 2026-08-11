import type { ProjectDetail } from "../../shared/contracts.js";
import { isResearchTaskSatisfiedByProduct } from "../../shared/research-task-satisfaction.js";
import { isCoverResearchTaskSatisfiedByProduct } from "../minimax/minimax.js";
import type { VbkDatabase } from "../infrastructure/database/database.js";

type RefreshDb = Pick<VbkDatabase, "getProject" | "markResearchTasksSatisfied">;

export interface RefreshedResearchIssues {
  updated: number;
  taskIds: string[];
}

export function refreshSatisfiedResearchTasks(db: RefreshDb, projectId: string): RefreshedResearchIssues {
  const project = db.getProject(projectId);
  if (!project) {
    throw new Error("项目不存在。");
  }
  const satisfiedIds = satisfiedResearchTaskIds(project);
  return db.markResearchTasksSatisfied(projectId, satisfiedIds);
}

export function satisfiedResearchTaskIds(project: ProjectDetail): string[] {
  return project.researchTasks
    .filter((task) =>
      task.state !== "confirmed" &&
      task.state !== "resolved" &&
      (isResearchTaskSatisfiedByProduct(task, project.product) ||
        isCoverResearchTaskSatisfiedByProduct(task, project.product)),
    )
    .map((task) => task.id);
}
