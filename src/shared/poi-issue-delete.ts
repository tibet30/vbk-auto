/** 待处理事项里的 POI 删除目标：按 research task 名称删除，或按具体行程位置删除。 */
export type PoiIssueDeleteTarget =
  | { taskId: string }
  | { dayIndex: number; spotIndex: number };
