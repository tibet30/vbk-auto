/**
 * three-stage-ai 共用工具 + 响应解析：
 *   - text：trim 字符串；
 *   - parseItineraryDay：AI 行程日 row → PlanningItineraryDayDraft；poiIds 用 Number
 *     转换；mealDescriptions 必须恰好 3 项；
 *   - normaliseName：去空白 / 分隔符，做大小写无关的 key；
 *   - sanitisePlanningRequest：把 userIdea / userIntent.rawIdea 都走
 *     sanitiseUserIdeaForAi（共享 system / 接入方清洗逻辑）；
 *   - isForbiddenCandidateName：禁词（酒店 / 机场 / 车站 / 码头 / 集合点 /
 *     停车场 / 售票处 / 入口 / 游客中心） + "和 / 与" 组合名称。
 */

import type { AiUsageSource } from "../../../../shared/contracts-ai-usage.js";
import { sanitiseUserIdeaForAi } from "../../vbk-copy-policy.js";
import type { PlanningItineraryDayDraft } from "../../../../shared/contracts-planning.js";
import { PlannerError } from "../../../../shared/contracts-planning.js";

export function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parseItineraryDay(value: unknown): PlanningItineraryDayDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PlannerError("invalid_model_output", "AI 返回了无效的行程日。 ");
  }
  const row = value as Record<string, unknown>;
  return {
    day: Number(row.day),
    title: String(row.title ?? "").trim(),
    description: String(row.description ?? "").trim(),
    poiIds: Array.isArray(row.poiIds) ? row.poiIds.map(Number) : [],
    meals: String(row.meals ?? "早餐自理；午餐自理；晚餐自理").trim(),
    mealDescriptions: Array.isArray(row.mealDescriptions) && row.mealDescriptions.length === 3
      ? row.mealDescriptions.map((item) => String(item)) as [string, string, string]
      : undefined,
  };
}

export function normaliseName(value: string): string {
  return value.toLowerCase().replace(/[\s·•・—_()（）【】\[\]景区风景区旅游区]/g, "");
}

export function sanitisePlanningRequest<T extends { userIdea?: string; userIntent?: { rawIdea?: string } }>(request: T): T {
  const userIdea = sanitiseUserIdeaForAi(request.userIdea ?? request.userIntent?.rawIdea ?? "");
  return {
    ...request,
    ...(request.userIdea !== undefined ? { userIdea } : {}),
    ...(request.userIntent ? { userIntent: { ...request.userIntent, rawIdea: userIdea } } : {}),
  };
}

export function isForbiddenCandidateName(value: string): boolean {
  return /酒店|宾馆|民宿|客栈|机场|车站|火车站|高铁站|码头|集合点|停车场|售票处|入口|游客中心|\s(?:和|与|及|、|\+)\s/.test(value)
    || /[、+&＋]|和.+(?:寺|山|馆|园|湖|沟|城|村)|与.+(?:寺|山|馆|园|湖|沟|城|村)/.test(value);
}

export const ENTRY_SOURCE: Record<
  "ThreeStage.structureLocation" | "ThreeStage.structureUserIntent" | "ThreeStage.disambiguatePoiCandidate" | "ThreeStage.correctPoiName" | "ThreeStage.recommendSpotNames" | "ThreeStage.composeVerifiedItinerary" | "ThreeStage.estimateVehicleTotalCost",
  AiUsageSource
> = {
  "ThreeStage.structureLocation": "planning.structureLocation",
  "ThreeStage.structureUserIntent": "planning.structureUserIntent",
  "ThreeStage.disambiguatePoiCandidate": "planning.disambiguatePoi",
  "ThreeStage.correctPoiName": "planning.resolvePoiName",
  "ThreeStage.recommendSpotNames": "planning.recommendSpotNames",
  "ThreeStage.composeVerifiedItinerary": "planning.composeItinerary",
  "ThreeStage.estimateVehicleTotalCost": "planning.estimateVehicleCost",
};

// Re-export commonly-shared helper for callers that need rawIdea sanitisation.
export { sanitiseUserIdeaForAi };

// Avoid an unused-type warning for PlanningUserIntentRequest (consumed by callers).
export type { PlanningUserIntentRequest } from "../../../../shared/contracts-planning-intent.js";