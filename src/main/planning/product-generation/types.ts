import type { ProductDetail } from "../../../shared/contracts.js";
import type {
  ModuleOutcome,
  PlanningModule,
  PlanningStage,
  PlanningStageOutput,
  ResearchTaskProposal,
} from "../../../shared/contracts-planning.js";
import type { OrchestratorRuntime } from "../types.js";

export type ProductGenerationStage = Extract<
  PlanningStage,
  "skeleton" | "basicInfo" | "itinerary" | "presentation" | "commercial"
>;

export interface ProductGenerationAppliedResult {
  accepted: ModuleOutcome[];
  rejected: ModuleOutcome[];
  researchTasks: ResearchTaskProposal[];
  hasAccepted: boolean;
}

export interface ProductGenerationResult {
  applied: ProductGenerationAppliedResult;
  deterministicAcceptedModules: PlanningModule[];
}

export interface ProductGenerationDependencies {
  getProduct(localProductId: string): ProductDetail;
  generateStage(localProductId: string, stage: ProductGenerationStage): Promise<PlanningStageOutput>;
  runtime: OrchestratorRuntime;
  beforePresentation(localProductId: string): void | Promise<void>;
  clearUnverifiedItineraryPois(itinerary: unknown): void;
  resolveItineraryResources(localProductId: string): Promise<unknown>;
  refreshSatisfiedResearchTasks(localProductId: string): void | Promise<void>;
}
