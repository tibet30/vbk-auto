import type { ProductReadiness, ResearchTask } from "../../../../shared/contracts-types.js";
import { mergeReadinessIssues, openResearchTaskToIssue, readinessIssueSemanticKey } from "../../../../shared/readiness-issues.js";

export interface OpenIssueRow {
  label: string;
  detail: string;
  actionPrompt: string;
  taskId?: string;
}

function isPendingTask(task: ResearchTask): boolean {
  return task.state !== "confirmed" && task.state !== "resolved";
}

function taskPrompt(task: Pick<ResearchTask, "label">): string {
  return `请核查并处理：${task.label}。完成后说明结果，不要自动提交。`;
}

function issuePrompt(issue: ProductReadiness["issues"][number]): string {
  return `请补齐待处理项：${issue.label}。${issue.detail}`;
}

function mergeRows(left: OpenIssueRow, right: OpenIssueRow): OpenIssueRow {
  const [issue] = mergeReadinessIssues([
    { label: left.label, detail: left.detail },
    { label: right.label, detail: right.detail },
  ]);
  return {
    label: issue.label,
    detail: issue.detail,
    actionPrompt: right.actionPrompt.startsWith("请核查并处理") ? right.actionPrompt : left.actionPrompt,
    taskId: right.taskId ?? left.taskId,
  };
}

export function buildOpenIssueRows(readiness: ProductReadiness, taskList: ResearchTask[]): OpenIssueRow[] {
  const rows = new Map<string, OpenIssueRow>();
  const pendingTasksByKey = new Map<string, ResearchTask>();
  for (const task of taskList.filter(isPendingTask)) {
    const key = readinessIssueSemanticKey(openResearchTaskToIssue(task));
    if (!pendingTasksByKey.has(key)) pendingTasksByKey.set(key, task);
  }

  const push = (issue: ProductReadiness["issues"][number], actionPrompt: string, task?: ResearchTask) => {
    const key = readinessIssueSemanticKey(issue);
    const row = {
      label: issue.label,
      detail: issue.detail,
      actionPrompt: task ? taskPrompt(task) : actionPrompt,
      taskId: task?.id,
    };
    const existing = rows.get(key);
    rows.set(key, existing ? mergeRows(existing, row) : row);
  };

  for (const issue of mergeReadinessIssues(readiness.issues)) {
    const key = readinessIssueSemanticKey(issue);
    push(issue, issuePrompt(issue), pendingTasksByKey.get(key));
  }
  return [...rows.values()];
}
