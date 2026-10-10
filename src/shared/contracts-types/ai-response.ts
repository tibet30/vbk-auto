/**
 * AI 通用响应形状：reply + patch + questions + researchTasks。
 * 与规划子系统的 PlanningStageOutput 不同，这是更通用的"AI 一次回复"
 * 包装，被 productDetail / manual review 等模块共用。
 */

import type { ResearchTask } from "./conversation.js";

export interface AiResponse {
  reply: string;
  patch?: Array<{ op: "add" | "replace" | "remove"; path: string; value?: unknown }>;
  questions?: string[];
  researchTasks?: Array<Pick<ResearchTask, "label" | "type" | "detail">>;
}