import type { ProductDetail } from "../../shared/contracts.js";
import type { PlanningStageOutput } from "../../shared/contracts-planning.js";
import type { TrafficLineEndpointAvailability } from "../../shared/contracts-traffic-line.js";
import type { ProductMutationService } from "../application/product-mutation-service.js";
import type { ProductWorkflowCoordinator } from "../application/product-workflow-coordinator.js";
import type { VbkDatabase } from "../infrastructure/database/database.js";
import type { VbkBrowser } from "../infrastructure/vbk-browser.js";
import type { DraftAutomation } from "../automation/automation.js";
import { DbOrchestratorRuntime } from "../planning/runtime.js";
import { repairExcludedAlternativeCopy } from "../planning/itinerary-alternative-copy.js";
import { excludedItineraryCopyConflicts } from "../planning/itinerary-alternative-consistency.js";
import {
  ProductGenerationService,
  hasCompletePresentationRecommendations,
  patchRequestsRecommendations,
  type ProductGenerationStage,
} from "../planning/product-generation.js";
import { refreshSatisfiedResearchTasks } from "../operations/research-refresh.js";
import type { AgentTool } from "./types.js";
import type { ResourceQueryOverrides } from '../planning/resource-query-overrides.js';
import { unavailableRecommendationCategories } from '../../shared/recommendation-category-policy.js';

type JsonObject = Record<string, unknown>;
type GenerateStage = ProductGenerationStage;

export interface AgentBusinessDependencies {
  resourceQueries?: ResourceQueryOverrides;
  generateCover?: import("../operations/generated-cover.js").CoverGenerator;
  inspectCover?: typeof import("../automation/manual-cover-asset.js").inspectManualCoverAsset;
  readiness?: (localProductId: string) => import("../../shared/contracts.js").ProductReadiness;
  db: VbkDatabase;
  browser: VbkBrowser;
  automation: DraftAutomation;
  productWorkflows: ProductWorkflowCoordinator;
  productMutations: ProductMutationService;
  generateStage(localProductId: string, stage: GenerateStage): Promise<PlanningStageOutput>;
  generateItineraryDayTitles?(localProductId: string, requests: import("../planning/itinerary-day-titles.js").ItineraryDayTitleRequest[]): Promise<Array<{ day: number; title: string }>>;
  disambiguatePoiOption(args: { localProductId: string; desired: string; product: Record<string, unknown>; candidates: Array<{ id: string; text: string }> }): Promise<{ pickedText: string | null; confidence: number }>;
  disambiguateStationOption(args: { localProductId: string; stationSubtype: "airport" | "train"; desired: string; product: Record<string, unknown>; candidates: Array<{ id?: string; text: string }> }): Promise<{ pickedText: string | null; reasoning: string }>;
  emitProduct(product: ProductDetail): void;
}

export { hasCompletePresentationRecommendations, patchRequestsRecommendations };

export function createGenerationStageTools(args: {
  deps: AgentBusinessDependencies;
  get: (localProductId: string) => ProductDetail;
  resolveTrafficAvailability: (localProductId: string) => Promise<TrafficLineEndpointAvailability | null>;
  resolveItineraryPoisAndTraffic: (localProductId: string) => Promise<unknown>;
  clearUnverifiedItineraryPois: (itinerary: unknown) => void;
}): AgentTool[] {
  const { deps, get, resolveTrafficAvailability, resolveItineraryPoisAndTraffic, clearUnverifiedItineraryPois } = args;
  const runtime = () => new DbOrchestratorRuntime(
    deps.db,
    deps.browser,
    deps.productMutations,
    (task) => deps.productWorkflows.runVbkPageExclusive(task),
    resolveTrafficAvailability,
    deps.disambiguatePoiOption,
    deps.resourceQueries,
  );
  const removeConvergedAlternativeDayCopy = (localProductId: string): boolean => {
    const saved = get(localProductId);
    const repaired = repairExcludedAlternativeCopy(saved, saved.product.itinerary);
    if (repaired.changed) {
      deps.productMutations.commands.mergeChanges(localProductId, saved, {
        ...saved.product,
        itinerary: repaired.itinerary,
      }, 'ai', { status: saved.status });
      deps.emitProduct(get(localProductId));
    }
    return repaired.changed;
  };
  const generation = () => new ProductGenerationService({
    getProduct: get,
    generateStage: (localProductId, stage) => deps.generateStage(localProductId, stage),
    runtime: runtime(),
    beforePresentation: (localProductId) => {
      removeConvergedAlternativeDayCopy(localProductId);
    },
    clearUnverifiedItineraryPois,
    resolveItineraryResources: resolveItineraryPoisAndTraffic,
    refreshSatisfiedResearchTasks: (localProductId) => {
      refreshSatisfiedResearchTasks(deps.db, localProductId);
    },
    ...(deps.generateItineraryDayTitles ? { generateItineraryDayTitles: deps.generateItineraryDayTitles } : {}),
  });

  return [
    {
      name: "generate_product_module",
      description: "用结构化规划模型生成一个且仅一个模块阶段。支持 skeleton、basicInfo、itinerary、presentation、commercial；输出经过该阶段的真实 schema、文案和城市锁定校验后才写入。",
      parameters: { type: "object", required: ["stage"], properties: { stage: { enum: ["skeleton", "basicInfo", "itinerary", "presentation", "commercial"] } } },
      async execute(toolArgs, ctx) {
        const stage = cleanText(toolArgs.stage) as GenerateStage;
        if (!(["skeleton", "basicInfo", "itinerary", "presentation", "commercial"] as string[]).includes(stage)) {
          throw new Error("不支持的生成阶段。");
        }
        const result = await generation().generate(ctx.localProductId, stage);
        const { applied } = result;
        const pricingDraft = result.deterministicAcceptedModules.includes("pricing");
        return {
          content: safeJson({
            stage,
            accepted: applied.accepted,
            rejected: applied.rejected,
            researchTasks: applied.researchTasks,
            ...(pricingDraft ? { pricingSemantics: "localReviewDraft" } : {}),
          }),
        };
      },
    },
    {
      name: "ensure_presentation_recommendations",
      description: "确定性处理产品图文的推荐理由：若已有恰好 3 条有效且分类不重复的推荐理由，直接确认；否则仅重新生成 presentation，并在写入后回读验证。",
      parameters: { type: "object", properties: {} },
      async execute(_toolArgs, ctx) {
        const current = get(ctx.localProductId).product as JsonObject;
        const policy = await runtime().resolveRecommendationCategoryPolicy(ctx.localProductId);
        if (hasCompletePresentationRecommendations(current.presentation)
          && unavailableRecommendationCategories(current.presentation, policy).length === 0
          && excludedItineraryCopyConflicts(get(ctx.localProductId)).length === 0) {
          return { content: "推荐理由已处理完成：当前已保存 3 条有效且分类不重复的推荐理由。", data: { recommendationsVerified: true, alreadySatisfied: true } };
        }
        // 类别失效或描述已删除景点时整体交给模型重新生成，不再用本地兜底文案重建。
        const { applied } = await generation().generate(ctx.localProductId, "presentation");
        return {
          content: "推荐理由已处理完成：已重新生成图文并回读验证 3 条推荐理由。",
          data: { recommendationsVerified: true, accepted: applied.accepted.map((outcome) => outcome.module) },
        };
      },
    },
  ];
}

function cleanText(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function safeJson(value: unknown): string { return JSON.stringify(value, null, 2).slice(0, 24_000); }
