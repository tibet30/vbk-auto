/** 用户想法在新版规划链路中的结构化投影。 */

export type PlanningUserActivityKind =
  | "poi"
  | "activity"
  | "transport"
  | "meal"
  | "hotel"
  | "free";

export interface PlanningUserActivityIntent {
  /** 同一轮解析内的稳定标识，用于把 POI 查询结果关联回用户原始安排。 */
  id: string;
  /** 0 表示用户没有指定日期；正数表示必须保留在该日。 */
  day: number;
  title: string;
  kind: PlanningUserActivityKind;
  /** “甲或乙 / 二选一”时的独立候选，按用户原始顺序保存；title 为默认第一项。 */
  alternatives?: string[];
  /** 用户提出的服务诉求；仅供规划参考，不代表资源已经确认。 */
  serviceNotes?: string[];
  /** 不限 / 全天 / 上午 / 下午 / 晚上 / HH:mm。 */
  time?: string;
  detail?: string;
  durationMinutes?: number;
}

export interface PlanningUserIntent {
  rawIdea: string;
  preferences: string[];
  activities: PlanningUserActivityIntent[];
}

export interface PlanningUserIntentRequest {
  userIdea: string;
  destination: string;
  days: number;
}

export interface PlanningOtherActivity {
  time: string;
  title: string;
  detail: string;
  type: "other";
  durationMinutes?: number;
  source: "user";
}

export function emptyPlanningUserIntent(rawIdea = ""): PlanningUserIntent {
  return { rawIdea: rawIdea.trim(), preferences: [], activities: [] };
}
