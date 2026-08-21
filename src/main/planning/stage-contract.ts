/**
 * 规划阶段与允许模块的静态契约。
 *
 * 单独放置以供 schema 校验、工具 schema、阶段执行器共同依赖，避免
 * schemas.ts 与 tool-schema.ts 互相导入形成循环。
 */

import type { PlanningModule, PlanningStage } from "../../shared/contracts-planning.js";

export const STAGE_ALLOWED_MODULES: Record<PlanningStage, readonly PlanningModule[]> = {
  skeleton: ["skeleton"],
  basicInfo: ["basicInfo"],
  itinerary: ["itinerary"],
  presentation: ["presentation"],
  // 条款由 VBK 条款页在自动化阶段写入，不属于 AI 规划输出。
  commercial: ["pricing", "inventory", "release"],
  research: ["researchTasks"],
  validation: [],
};
