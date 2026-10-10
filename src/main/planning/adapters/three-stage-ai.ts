/**
 * OpenAIThreeStagePlanningAi：把 7 个 stage 入口（structureLocation /
 * structureUserIntent / disambiguatePoiCandidate / correctPoiName /
 * recommendSpotNames / composeVerifiedItinerary / estimateVehicleTotalCost）
 * 接到 ThreeStagePlanningAi 接口。
 *
 * 子文件分工：
 *   - util.ts：text / parseItineraryDay / normaliseName / sanitisePlanningRequest /
 *     isForbiddenCandidateName + ENTRY_SOURCE；
 *   - transport.ts：callTool + createCompletion（OpenAI 完成 + 超时 + logAIPrompt）；
 *   - stages.ts：7 个 stage 方法实现。
 */

import OpenAI from "openai";
import type { ThreeStagePlanningAi } from "../../../shared/contracts-planning.js";
import type { AiUsageEvent } from "../../../shared/contracts-ai-usage.js";
import type { CallToolDeps } from "./three-stage-ai/transport.js";
import { structureLocation, structureUserIntent, disambiguatePoiCandidate, correctPoiName, recommendSpotNames, composeVerifiedItinerary, estimateVehicleTotalCost } from "./three-stage-ai/stages.js";

export interface ThreeStageAiConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  provider?: string;
  extraParams?: Record<string, unknown>;
  timeoutMs?: number;
  recordUsage?: (event: AiUsageEvent) => void;
}

export class OpenAIThreeStagePlanningAi implements ThreeStagePlanningAi {
  private readonly client: OpenAI;
  private readonly timeoutMs: number;
  private readonly extraParams?: Record<string, unknown>;
  private usageScope?: { localProductId: string; runId?: string };
  private readonly deps: CallToolDeps;

  constructor(private readonly config: ThreeStageAiConfig) {
    this.timeoutMs = config.timeoutMs ?? 90_000;
    this.extraParams = config.extraParams;
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      timeout: this.timeoutMs,
      maxRetries: 0,
    });
    this.deps = {
      client: this.client,
      timeoutMs: this.timeoutMs,
      provider: config.provider,
      model: config.model,
      recordUsage: config.recordUsage,
      get usageScope() { return undefined; },
    };
  }

  withUsageScope(scope: { localProductId: string; runId?: string }): this {
    this.usageScope = scope;
    (this.deps as { usageScope?: typeof scope }).usageScope = scope;
    return this;
  }

  structureLocation(request: Parameters<NonNullable<ThreeStagePlanningAi["structureLocation"]>>[0]) {
    return structureLocation(this.deps, request);
  }

  structureUserIntent(request: Parameters<NonNullable<ThreeStagePlanningAi["structureUserIntent"]>>[0]) {
    return structureUserIntent(this.deps, request);
  }

  disambiguatePoiCandidate(request: Parameters<NonNullable<ThreeStagePlanningAi["disambiguatePoiCandidate"]>>[0]) {
    return disambiguatePoiCandidate(this.deps, request);
  }

  correctPoiName(request: Parameters<NonNullable<ThreeStagePlanningAi["correctPoiName"]>>[0]) {
    return correctPoiName(this.deps, request);
  }

  recommendSpotNames(request: Parameters<ThreeStagePlanningAi["recommendSpotNames"]>[0]) {
    return recommendSpotNames(this.deps, request);
  }

  composeVerifiedItinerary(request: Parameters<ThreeStagePlanningAi["composeVerifiedItinerary"]>[0]) {
    return composeVerifiedItinerary(this.deps, request);
  }

  estimateVehicleTotalCost(request: Parameters<ThreeStagePlanningAi["estimateVehicleTotalCost"]>[0]) {
    return estimateVehicleTotalCost(this.deps, request);
  }
}

// Re-export the helpers so existing test / external imports keep working.
export { structureLocation, structureUserIntent, disambiguatePoiCandidate, correctPoiName, recommendSpotNames, composeVerifiedItinerary, estimateVehicleTotalCost } from "./three-stage-ai/stages.js";