import type { ProductDetail, ProductReadiness, ResearchTask } from "../../../../shared/contracts-types.js";
import { mergeReadinessIssues, openResearchTaskToIssue, readinessIssueSemanticKey } from "../../../../shared/readiness-issues.js";
import { poiResearchTaskNames } from "../../../../shared/poi-research-tasks.js";
import { samePoiName } from "../../../../shared/poi-name-key.js";
import type { PoiIssueDeleteTarget } from "../../../../shared/poi-issue-delete.js";

export interface OpenIssueRow {
  label: string;
  detail: string;
  actionPrompt: string;
  taskId?: string;
  /** 仅 POI 行出现：删除待处理项并同步移除行程中的对应景点。 */
  poiDeleteTarget?: PoiIssueDeleteTarget;
  /** 删除确认文案使用的 POI 名称。 */
  poiName?: string;
}

function isPendingTask(task: ResearchTask): boolean {
  return task.state !== "confirmed" && task.state !== "resolved";
}

function isPoiTask(task: ResearchTask): boolean {
  return poiResearchTaskNames(task.label, task.type).length > 0;
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
    poiDeleteTarget: right.poiDeleteTarget ?? left.poiDeleteTarget,
    poiName: right.poiName ?? left.poiName,
  };
}

function regionIssueTarget(product: ProductDetail, label: string): { target: PoiIssueDeleteTarget; name: string } | undefined {
  const match = /^第(\d+)天景点地域：(.+)$/u.exec(label);
  if (!match) return undefined;
  const dayNumber = Number(match[1]);
  const name = match[2]!.trim();
  const dayIndex = product.product.itinerary instanceof Array
    ? product.product.itinerary.findIndex((day) => Number((day as { day?: unknown })?.day) === dayNumber)
    : -1;
  if (dayIndex < 0) return undefined;
  const spots = (product.product.itinerary as Array<{ spots?: unknown[] }>)[dayIndex]?.spots;
  const spotIndex = Array.isArray(spots) ? spots.findIndex((spot) => {
    const record = spot as { name?: unknown; poiName?: unknown };
    return samePoiName(record?.name, name) || samePoiName(record?.poiName, name);
  }) : -1;
  return spotIndex >= 0 ? { target: { dayIndex, spotIndex }, name } : undefined;
}

export function buildOpenIssueRows(
  readiness: ProductReadiness,
  taskList: ResearchTask[],
  product?: ProductDetail,
): OpenIssueRow[] {
  const rows = new Map<string, OpenIssueRow>();
  const pendingTasksByKey = new Map<string, ResearchTask>();
  for (const task of taskList.filter(isPendingTask)) {
    const key = readinessIssueSemanticKey(openResearchTaskToIssue(task));
    if (!pendingTasksByKey.has(key)) pendingTasksByKey.set(key, task);
  }

  const push = (issue: ProductReadiness["issues"][number], actionPrompt: string, task?: ResearchTask) => {
    const key = readinessIssueSemanticKey(issue);
    const region = !task && product ? regionIssueTarget(product, issue.label) : undefined;
    const row: OpenIssueRow = {
      label: issue.label,
      detail: issue.detail,
      actionPrompt: task ? taskPrompt(task) : actionPrompt,
      taskId: task?.id,
      ...(task && isPoiTask(task) ? { poiDeleteTarget: { taskId: task.id }, poiName: poiTaskName(task) } : {}),
      ...(region ? { poiDeleteTarget: region.target, poiName: region.name } : {}),
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

function poiTaskName(task: ResearchTask): string {
  return poiResearchTaskNames(task.label, task.type)[0] ?? task.label;
}
