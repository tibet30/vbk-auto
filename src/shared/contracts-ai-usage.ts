/**
 * 产品级 AI Token 用量契约。
 * 挂在 ProductDetail.aiUsage（与 planning 同级），权威存储在 Tibet。
 */

export type AiUsageSource =
  | "planning.generateStage"
  | "planning.structureLocation"
  | "planning.structureUserIntent"
  | "planning.disambiguatePoi"
  | "planning.recommendSpotNames"
  | "planning.composeItinerary"
  | "planning.estimateVehicleCost"
  | "planning.resolvePoiName"
  | "chat.reply"
  | "chat.regenerate"
  | "automation.disambiguate"
  | "automation.diagnose";

export interface AiUsageEvent {
  id: string;
  runId?: string;
  source: AiUsageSource;
  stage?: string;
  attempt?: number;
  model: string;
  provider: string;
  status: "ok" | "error";
  errorCode?: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cachedTokens?: number | null;
  reasoningTokens?: number | null;
  /** 按 model/tokens 估算的人民币（元）；桌面本地刊例价或 Tibet 回写。 */
  estimatedCostCny?: number | null;
}

export interface AiUsageTotals {
  calls: number;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  tokensIncomplete: boolean;
  estimatedCostCny: number | null;
}

export interface ProductAiUsage {
  events: AiUsageEvent[];
  lifetime: AiUsageTotals;
  latestRun: AiUsageTotals & { runId?: string };
  byStage: Array<{ stage: string; totals: AiUsageTotals }>;
}

export const AI_USAGE_EVENT_CAP = 500;
