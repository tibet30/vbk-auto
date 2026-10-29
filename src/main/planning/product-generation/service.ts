import { isReplayDataMissing } from "../../infrastructure/replay-data-error.js";
import type { PlanningStageError, PlanningStageOutput } from "../../../shared/contracts-planning.js";
import { projectCompleteItinerary } from "../complete-itinerary-projection.js";
import { ensureDayTitleFits, generateItineraryDayTitles, itineraryDaySourceText, privateTourDayTitleFacts } from "../itinerary-day-titles.js";
import { itineraryDayTitleBudget, itineraryDayTitleProblem } from "../../../shared/itinerary-day-title.js";
import { isPrivateTourProduct, privateTourDayTitleProblem } from "../../../shared/private-tour-day-title.js";
import { logWarn } from "../../../shared/log-timestamp.js";
import { excludedItineraryCopyConflicts } from "../itinerary-alternative-consistency.js";
import { executeStageOutput } from "../stage-runner.js";
import {
  applyStageDeterministicCompletion,
  skeletonFromProduct,
} from "../stage-deterministic-completion.js";
import type {
  ProductGenerationDependencies,
  ProductGenerationResult,
  ProductGenerationStage,
} from "./types.js";
import {
  assertPersistedItinerary,
  hasCompletePresentationRecommendations,
  normaliseOutcomeSummaries,
  verifyPersistedOutcomes,
} from "./validation.js";

type JsonObject = Record<string, unknown>;

/** Active product-generation use case shared by Agent tool adapters. */
export class ProductGenerationService {
  constructor(private readonly deps: ProductGenerationDependencies) {}

  async generate(localProductId: string, stage: ProductGenerationStage, previousError?: PlanningStageError): Promise<ProductGenerationResult> {
    if (stage === "presentation") await this.deps.beforePresentation(localProductId);
    const output = await this.stageOutput(localProductId, stage, previousError);
    if (stage === "itinerary") this.clearGeneratedPoiClaims(output);

    const applied = await executeStageOutput({
      stage,
      output,
      runtime: this.deps.runtime,
      localProductId,
    });
    const extra = await applyStageDeterministicCompletion({
      stage,
      localProductId,
      skeleton: skeletonFromProduct(this.deps.getProduct(localProductId).product as JsonObject),
      runtime: this.deps.runtime,
    });
    const accepted = [...applied.accepted, ...extra.accepted];
    const rejected = [...applied.rejected, ...extra.rejected];

    if (stage === "itinerary") await this.validateAndResolveItinerary(localProductId, accepted, rejected);
    if (stage === "presentation") this.validatePresentation(localProductId, accepted, rejected);

    const persisted = verifyPersistedOutcomes(this.deps.getProduct(localProductId), accepted, rejected);
    const summary = normaliseOutcomeSummaries(persisted.accepted, persisted.rejected);
    const verifiedModules = new Set(summary.accepted.map((item) => item.module));
    return {
      applied: { ...summary, researchTasks: applied.researchTasks },
      deterministicAcceptedModules: [...new Set(
        extra.accepted.map((item) => item.module).filter((module) => verifiedModules.has(module)),
      )],
    };
  }

  private async stageOutput(
    localProductId: string,
    stage: ProductGenerationStage,
    previousError?: PlanningStageError,
  ): Promise<PlanningStageOutput> {
    const projected = stage === "itinerary"
      ? projectCompleteItinerary(this.deps.getProduct(localProductId))
      : undefined;
    if (projected) return this.withDayTitles(localProductId, projected, true);
    try {
      const output = await this.deps.generateStage(localProductId, stage, previousError);
      return stage === "itinerary" ? this.withDayTitles(localProductId, output, false) : output;
    } catch (error) {
      // 只有商业阶段可转本地确定性补全；图文失败必须如实失败，不再生成兜底文案。
      if (isReplayDataMissing(error) || stage !== "commercial") throw error;
      return {
        reply: error instanceof Error ? error.message : "结构化生成失败，转入本地确定性补全。",
        modules: [],
      };
    }
  }

  /**
   * 天标题有 VBK 长度上限。确定性投影的标题由 AI 重写；规划模型自带的标题
   * 只在超限或含分节/建议时才重写。AI 不可用或不合格时用不截断的兜底标题。
   */
  private async withDayTitles(localProductId: string, output: PlanningStageOutput, projected: boolean): Promise<PlanningStageOutput> {
    const product = this.deps.getProduct(localProductId);
    const productJson = product.product as JsonObject;
    const modules = await Promise.all(output.modules.map(async (module) => {
      if (module.module !== "itinerary" || !Array.isArray(module.value)) return module;
      const itinerary = module.value as JsonObject[];
      const budget = (day: JsonObject) => itineraryDayTitleBudget(productJson, Number(day.day));
      const needsTitle = (day: JsonObject) => projected || Boolean(isPrivateTourProduct(productJson)
        ? privateTourDayTitleProblem(String(day.title ?? ""), budget(day), privateTourDayTitleFacts(productJson, day))
        : itineraryDayTitleProblem(String(day.title ?? ""), budget(day)));
      const targets = itinerary.filter(needsTitle);
      if (!targets.length) return module;
      const generate = this.deps.generateItineraryDayTitles;
      const titled = generate
        ? await generateItineraryDayTitles({
          product: productJson,
          itinerary: targets,
          sourceText: (day) => itineraryDaySourceText(product, day),
          generate: (requests) => generate(localProductId, requests),
          onWarning: (message) => logWarn("[planning] itinerary day title", { localProductId, message }),
        })
        : targets;
      const byDay = new Map(titled.map((day) => [Number(day.day), day]));
      return { ...module, value: itinerary.map((day) => ensureDayTitleFits(productJson, byDay.get(Number(day.day)) ?? day)) };
    }));
    return { ...output, modules };
  }

  private clearGeneratedPoiClaims(output: PlanningStageOutput): void {
    for (const module of output.modules) {
      if (module.module === "itinerary") this.deps.clearUnverifiedItineraryPois(module.value);
    }
  }

  private async validateAndResolveItinerary(
    localProductId: string,
    accepted: ProductGenerationResult["applied"]["accepted"],
    rejected: ProductGenerationResult["applied"]["rejected"],
  ): Promise<void> {
    if (!accepted.some((outcome) => outcome.module === "itinerary")) {
      const detail = rejected
        .filter((outcome) => outcome.module === "itinerary")
        .map((outcome) => outcome.reason)
        .filter(Boolean)
        .join("；");
      throw new Error(`每日行程未处理：生成结果未通过结构或锁定校验${detail ? `（${detail}）` : ""}。`);
    }
    assertPersistedItinerary(this.deps.getProduct(localProductId));
    await this.deps.resolveItineraryResources(localProductId);
    await this.deps.refreshSatisfiedResearchTasks(localProductId);
    assertPersistedItinerary(this.deps.getProduct(localProductId));
  }

  private validatePresentation(
    localProductId: string,
    accepted: ProductGenerationResult["applied"]["accepted"],
    rejected: ProductGenerationResult["applied"]["rejected"],
  ): void {
    if (!accepted.some((outcome) => outcome.module === "presentation")) {
      const detail = rejected.map((outcome) => outcome.reason).filter(Boolean).join("；");
      throw new Error(`推荐理由未处理：图文生成没有写入 presentation 模块${detail ? `（${detail}）` : ""}。`);
    }
    const saved = this.deps.getProduct(localProductId);
    if (!hasCompletePresentationRecommendations((saved.product as JsonObject).presentation)) {
      throw new Error("推荐理由未处理：写入后必须恰好保留 3 条分类不重复、文本非空的 recommendations。");
    }
    const conflicts = excludedItineraryCopyConflicts(saved);
    if (conflicts.length) {
      throw new Error(`推荐理由未处理：写入后仍描述已排除的行程选项（${conflicts.join("、")}）。`);
    }
  }
}
