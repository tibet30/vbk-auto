/**
 * 对话 + 研究任务 + 证据：被 ProductDetail 复用，研究 / 历史会话的最小单位。
 *
 * "FieldState"是单个研究任务的状态机；"TaskStatus"是后台任务的执行状态。
 */

export type FieldState =
  | "proposed"
  | "researching"
  | "resolved"
  | "needs_confirmation"
  | "confirmed"
  | "blocked";

export type TaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  taskStatus?: TaskStatus;
}

export interface Evidence {
  id: string;
  title: string;
  url?: string;
  source: "vbk" | "web" | "user";
  retrievedAt: string;
  accepted: boolean;
  /** POI 核查受控凭证的结构化映射；title 同时保留文本形式供旧读取方使用。 */
  poiMappings?: Array<{ day: number; spotId?: string; spotName: string; poiName: string; poiId: number }>;
}

export interface ResearchTask {
  id: string;
  label: string;
  type: "vbk" | "web" | "cost" | "image";
  status: TaskStatus;
  state: FieldState;
  detail?: string;
  evidence?: Evidence[];
}