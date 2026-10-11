import { isReplayDataMissing } from "../../infrastructure/replay-data-error.js";
import type { PlanningStageOutput } from "../../../shared/contracts-planning.js";
import { projectCompleteItinerary } from "../complete-itinerary-projection.js";
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

  async generate(localProductId: string, stage: ProductGenerationStage): Promise<ProductGenerationResult> {
    if (stage === "presentation") await this.deps.beforePresentation(localProductId);
    const output = await this.stageOutput(localProductId, stage);
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
  ): Promise<PlanningStageOutput> {
    const projected = stage === "itinerary"
      ? projectCompleteItinerary(this.deps.getProduct(localProductId))
      : undefined;
    if (projected) return projected;
    try {
      return await this.deps.generateStage(localProductId, stage);
    } catch (error) {
      if (isReplayDataMissing(error) || stage !== "presentation" && stage !== "commercial") throw error;
      return {
        reply: error instanceof Error ? error.message : "结构化生成失败，转入本地确定性补全。",
        modules: [],
      };
    }
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
