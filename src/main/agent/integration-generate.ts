import type { ProductDetail } from "../../shared/contracts.js";
import type { PlanningStage, PlanningStageOutput } from "../../shared/contracts-planning.js";
import type { TrafficLineEndpointAvailability } from "../../shared/contracts-traffic-line.js";
import type { ProductMutationService } from "../application/product-mutation-service.js";
import type { ProductWorkflowCoordinator } from "../application/product-workflow-coordinator.js";
import type { VbkDatabase } from "../infrastructure/database/database.js";
import type { VbkBrowser } from "../infrastructure/vbk-browser.js";
import type { DraftAutomation } from "../automation/automation.js";
import { DbOrchestratorRuntime } from "../planning/runtime.js";
import { executeStageOutput } from "../planning/stage-runner.js";
import { applyStageDeterministicCompletion, skeletonFromProduct } from "../planning/stage-deterministic-completion.js";
import { refreshSatisfiedResearchTasks } from "../operations/research-refresh.js";
import type { AgentTool } from "./types.js";

type JsonObject = Record<string, unknown>;
type GenerateStage = Extract<PlanningStage, "skeleton" | "basicInfo" | "itinerary" | "presentation" | "commercial">;

export interface AgentBusinessDependencies {
  db: VbkDatabase;
  browser: VbkBrowser;
  automation: DraftAutomation;
  productWorkflows: ProductWorkflowCoordinator;
  productMutations: ProductMutationService;
  generateStage(localProductId: string, stage: GenerateStage): Promise<PlanningStageOutput>;
  disambiguatePoiOption(args: { localProductId: string; desired: string; product: Record<string, unknown>; candidates: Array<{ id: string; text: string }> }): Promise<{ pickedText: string | null; confidence: number }>;
  disambiguateStationOption(args: { localProductId: string; stationSubtype: "airport" | "train"; desired: string; product: Record<string, unknown>; candidates: Array<{ id?: string; text: string }> }): Promise<{ pickedText: string | null; reasoning: string }>;
  emitProduct(product: ProductDetail): void;
}

type Recommendation = { category: string; text: string };

export function hasCompletePresentationRecommendations(value: unknown): value is { recommendations: Recommendation[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const recommendations = (value as JsonObject).recommendations;
  if (!Array.isArray(recommendations) || recommendations.length !== 3) return false;
  const categories = new Set<string>();
  return recommendations.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const category = cleanText((item as JsonObject).category);
    const text = cleanText((item as JsonObject).text);
    if (!category || !text || categories.has(category)) return false;
    categories.add(category);
    return true;
  });
}

export function patchRequestsRecommendations(patch: JsonObject): boolean {
  const presentation = patch.presentation;
  return Boolean(presentation && typeof presentation === "object" && !Array.isArray(presentation)
    && Object.hasOwn(presentation, "recommendations"));
}

export function createGenerationStageTools(args: {
  deps: AgentBusinessDependencies;
  get: (localProductId: string) => ProductDetail;
  resolveTrafficAvailability: (localProductId: string) => Promise<TrafficLineEndpointAvailability | null>;
  resolveItineraryPoisAndTraffic: (localProductId: string) => Promise<unknown>;
  clearUnverifiedItineraryPois: (itinerary: unknown) => void;
}): AgentTool[] {
  const { deps, get, resolveTrafficAvailability, resolveItineraryPoisAndTraffic, clearUnverifiedItineraryPois } = args;
  const generateModule = async (localProductId: string, stage: GenerateStage) => {
    const output = await deps.generateStage(localProductId, stage);
    if (stage === "itinerary") {
      for (const module of output.modules) {
        if (module.module === "itinerary") clearUnverifiedItineraryPois(module.value);
      }
    }
    const runtime = new DbOrchestratorRuntime(
      deps.db,
      deps.browser,
      deps.productMutations,
      (task) => deps.productWorkflows.runVbkPageExclusive(task),
      resolveTrafficAvailability,
      deps.disambiguatePoiOption,
    );
    const applied = await executeStageOutput({ stage, output, runtime, localProductId });
    const extra = await applyStageDeterministicCompletion({
      stage,
      localProductId,
      skeleton: skeletonFromProduct(get(localProductId).product as JsonObject),
      runtime,
    });
    applied.accepted.push(...extra.accepted);
    applied.rejected.push(...extra.rejected);
    if (stage === "itinerary" && applied.accepted.some((outcome) => outcome.module === "itinerary")) {
      await resolveItineraryPoisAndTraffic(localProductId);
      refreshSatisfiedResearchTasks(deps.db, localProductId);
    }
    if (stage === "presentation") {
      if (!applied.accepted.some((outcome) => outcome.module === "presentation")) {
        const detail = applied.rejected.map((outcome) => outcome.reason).filter(Boolean).join("；");
        throw new Error(`推荐理由未处理：图文生成没有写入 presentation 模块${detail ? `（${detail}）` : ""}。`);
      }
      if (!hasCompletePresentationRecommendations((get(localProductId).product as JsonObject).presentation)) {
        throw new Error("推荐理由未处理：写入后必须恰好保留 3 条分类不重复、文本非空的 recommendations。");
      }
    }
    return { applied, extra };
  };

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
        const { applied, extra } = await generateModule(ctx.localProductId, stage);
        const pricingDraft = extra.accepted.some((item) => item.module === "pricing");
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
        if (hasCompletePresentationRecommendations(current.presentation)) {
          return { content: "推荐理由已处理完成：当前已保存 3 条有效且分类不重复的推荐理由。", data: { recommendationsVerified: true, alreadySatisfied: true } };
        }
        const { applied } = await generateModule(ctx.localProductId, "presentation");
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
