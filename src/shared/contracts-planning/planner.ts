/**
 * Planner 接口：provider-neutral。任何 adapter 必须实现该接口；orchestrator
 * 只能调用接口方法，不能直接判断 provider / model。
 *
 * 加上 PoiNameResolutionRequest / resolvePoiName 用于 VBK suggestPoi 未命中
 * 时给一个安全的替代名（不会猜测 ID）。
 */

import type {
  PlanningStage,
} from "./stages.js";
import type {
  PlanningLocationRequest,
  PlanningLocation,
} from "./requests.js";
import type {
  PlanningPoiDisambiguationRequest,
  PlanningPoiDisambiguationResult,
} from "../contracts-planning-poi-disambiguation.js";
import type {
  PlanningPoiNameCorrectionRequest,
  PlanningPoiNameCorrectionResult,
} from "../contracts-planning-poi-correction.js";
import type {
  PlanningSpotRecommendationRequest,
  PlanningItineraryRequest,
  PlanningItineraryDayDraft,
} from "./requests.js";
import type {
  PlanningUserIntent,
  PlanningUserIntentRequest,
} from "../contracts-planning-intent.js";
import type {
  PlanningStageOutput,
} from "./output.js";
import type {
  PlanningStageError,
} from "./output.js";
import type { LockedConstraints } from "../contracts-preparation.js";
import type { MemoryPromptContext } from "../contracts-types.js";
import type { ProductForm } from "../product-form.js";
import type {
  StagePersistedState,
} from "./state.js";
import type { ResearchTaskProposal } from "./modules.js";

export interface ThreeStagePlanningAi {
  structureLocation(request: PlanningLocationRequest): Promise<PlanningLocation>;
  structureUserIntent(request: PlanningUserIntentRequest): Promise<PlanningUserIntent>;
  disambiguatePoiCandidate?(
    request: PlanningPoiDisambiguationRequest,
  ): Promise<PlanningPoiDisambiguationResult>;
  correctPoiName?(
    request: PlanningPoiNameCorrectionRequest,
  ): Promise<PlanningPoiNameCorrectionResult>;
  recommendSpotNames(request: PlanningSpotRecommendationRequest): Promise<string[]>;
  composeVerifiedItinerary(request: PlanningItineraryRequest): Promise<PlanningItineraryDayDraft[]>;
  estimateVehicleTotalCost(request: {
    destination: string;
    province: string;
    city: string;
    days: number;
    itinerary: unknown[];
  }): Promise<number>;
}

/** 已固化的产品骨架字段；AI 不能修改，只能填占位。 */
export interface PlanningSkeleton {
  destination: string;
  days: number;
  nights: number;
  productForm: ProductForm;
  productType: "domesticShort" | "domesticLong";
  /** 系统生成的供应商产品编号（AI 不可修改）。 */
  supplierProductCode: string;
}

export interface PlannerContext {
  /** 已固化的产品骨架（destination / days / nights / productForm / sales）。 */
  skeleton: PlanningSkeleton;
  /** 当前产品草稿（来自数据库），用于 incremental 合并。 */
  currentProduct: Record<string, unknown>;
  /** 已接受的模块（来自 generation state），用于 incremental 输入。 */
  acceptedModules: StagePersistedState["accepted"];
  /** 已声明的 research tasks（用于「避免重复添加」）。 */
  existingResearchTasks: Array<Pick<ResearchTaskProposal, "label" | "type">>;
  /** 历史会话（只用于补充上下文；orchestrator 不依赖它做决策）。 */
  history: Array<{ role: "user" | "assistant"; content: string }>;
  /** 用户明确指定的目的地、天数、POI、行程顺序和交通方式；模型不得覆盖。 */
  lockedConstraints?: LockedConstraints;
  /** 已由真实 POI 绑定收敛的原始二选一备选；仅用于后续派生文案，不改变用户原始约束。 */
  excludedItineraryAlternatives?: Array<{ day: number; names: string[] }>;
  /** 用户明确保存的少量长期偏好，按预算裁剪后注入。 */
  memoryContext?: MemoryPromptContext;
  /** Provider / model 仅作为 transport 参数，schema / prompt 不依赖。 */
  transport: {
    providerLabel: string;
    model: string;
  };
}

export interface PlannerRequest {
  stage: PlanningStage;
  context: PlannerContext;
  /** 上次失败的错误信息（用于 retry hint）；orchestrator 只透传给 adapter。 */
  previousError?: PlanningStageError;
}

export interface Planner {
  /**
   * 调用 provider 返回结构化输出；本方法**只能**返回 PlanningStageOutput，
   * 不允许 RFC6902 patch。失败时抛出 PlannerError，orchestrator 捕获后
   * 走 retry 流程。
   */
  generateStage(request: PlannerRequest): Promise<PlanningStageOutput>;
  /**
   * 原始景点名称在 VBK suggestPoi 中未命中时，给出一个可再次查询的单一
   * POI 名称；该名称可作为同目的地/同核心城市内的替代景点。返回 null
   * 表示本轮无法给出安全候选；调用方不会猜测 ID。
   */
  resolvePoiName?(request: PoiNameResolutionRequest): Promise<string | null>;
}

export interface PoiNameResolutionRequest {
  originalName: string;
  destination: string;
  /** 1-based，最多三次。 */
  attempt: number;
  /** 已经实际交给 VBK suggestPoi 查询但未命中的候选；重试时不得重复。 */
  previousCandidates: readonly string[];
}