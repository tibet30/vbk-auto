/**
 * Planning 阶段的 POI 候选 + 备选名管理。
 *
 * 单个候选是「用户说的某地 → AI 提议的某 POI」的一次对齐尝试；多个备选
 * 名可同组入行程，便于「二选一 / 或者」类输入。
 */

export interface PlanningPoiCandidate {
  requestedName: string;
  status: "proposed" | "resolved" | "rejected" | "selected";
  source?: "user" | "ai";
  userActivityId?: string;
  preferredDay?: number;
  /** 用户"或者/二选一"等并列备选名称，按原始顺序保存；首项就是 requestedName。 */
  alternativeNames?: string[];
  /** 当前候选对应的备选名称在用户原始列表中的位置；多个可用项可同组入行程。 */
  selectedAlternativeIndex?: number;
  reason?: string;
  poiId?: number;
  poiName?: string;
  province?: string;
  city?: string;
  district?: string;
  address?: string;
}