/**
 * Planning subsystem contracts — provider-neutral, model-neutral.
 *
 * 整套规划子系统都使用本文件里定义的类型。Prompt / schema / validator / 重试
 * 策略 / status / research 规则都不能包含 provider 或 model 字样；只有
 * adapter（src/main/planning/adapters/*）里允许出现具体的 transport 参数。
 */

// ──────────────────────────────────────────────────────────────────────────
// 阶段：每一轮规划都按顺序经过 5 个阶段；任一阶段失败可单独重跑，
// 已通过阶段的结果会持久化下来用于续跑。
// ──────────────────────────────────────────────────────────────────────────
export type PlanningStage =
  | "skeleton"
  | "itinerary"
  | "presentation"
  | "commercial"
  | "research"
  | "validation";

export const PLANNING_STAGES: readonly PlanningStage[] = [
  "skeleton",
  "itinerary",
  "presentation",
  "commercial",
  "research",
  "validation",
] as const;

/**
 * 默认每阶段最多重试次数（含首跑）；超过后会进入 needs_user。
 * 与 adapter 的 maxAttempts=1 组合后，单个 AI 阶段在合理情况下的
 * planner 调用上限 = retryLimit（≤ 2）。
 */
export const PLANNING_STAGE_RETRY_LIMIT = 2;

// ──────────────────────────────────────────────────────────────────────────
// 模块：每个阶段会落盘若干模块；模块是「产品 JSON 里的一个子树」或
// 「一组运营数据」。系统只接受规划子系统显式声明的模块，不接受任意路径。
// ──────────────────────────────────────────────────────────────────────────
export type PlanningModule =
  | "presentation"
  | "itinerary"
  | "packageName"
  | "pricing"
  | "inventory"
  | "terms"
  | "release"
  | "researchTasks"
  | "skeleton";

export const REQUIRED_MODULES: readonly PlanningModule[] = [
  "presentation",
  "itinerary",
  "packageName",
  "pricing",
  "inventory",
  "terms",
  "release",
  "researchTasks",
] as const;

export type ModuleStatus = "missing" | "proposed" | "accepted" | "rejected";

export interface ModuleOutcome {
  module: PlanningModule;
  status: ModuleStatus;
  /** Module-level 校验失败的原因（如有）。 */
  reason?: string;
  /** Module 级 research tasks（仅 researchTasks 模块使用）。 */
  researchTasks?: ResearchTaskProposal[];
  /** Module 实际被写入的「固定路径」——不接受 RFC6902。 */
  writePath?: string;
  /** 系统从结构化输出里真正读到的字段摘要，供 UI 显示「接受到 / 缺失」。 */
  acceptedFields?: string[];
  /** 缺失字段列表（按 REQUIRED_MODULES + 子字段），供系统生成对话回复。 */
  missingFields?: string[];
  /** 模块原始 value（仅 orchestrator 内部使用，UI 不必展示）。 */
  value?: unknown;
}

/**
 * research task 提案：与现有 ResearchTask 一致结构，但这是 AI 输出 → 等待
 * VBK 或人工确认。AI 不能写「已解决」。
 */
export interface ResearchTaskProposal {
  label: string;
  type: "vbk" | "web" | "cost" | "image";
  detail?: string;
}

// ──────────────────────────────────────────────────────────────────────────
// 阶段输出：每个阶段只允许返回这一种结构。AI 不能写 RFC6902 patch。
// ──────────────────────────────────────────────────────────────────────────
export interface PlanningStageOutput {
  /** 给运营的中文回复，简短说明本阶段结果。 */
  reply: string;
  /** 本阶段产出的模块；可能是空（全部失败）或部分。 */
  modules: ModuleOutcome[];
  /** 阶段级问题（最多 1 条），仅当完全阻塞下一阶段才返回。 */
  question?: string;
}

export interface PlanningStageError {
  stage: PlanningStage;
  attempt: number;
  message: string;
  code: string;
  /** 失败原因细节（保留以便 UI 显示），但绝不持久化为产品字段。 */
  details?: string;
}

// ──────────────────────────────────────────────────────────────────────────
// 持久化：生成状态按 project_id 单行存储；用于「中途重启后从失败阶段续跑」。
// ──────────────────────────────────────────────────────────────────────────
export interface ModulePersistedState {
  module: PlanningModule;
  status: ModuleStatus;
  reason?: string;
  /** 真正写入的固定路径。AI 不允许自由路径。 */
  writePath?: string;
  acceptedFields?: string[];
  missingFields?: string[];
  /** 模块写入或失败时的 ISO timestamp。 */
  updatedAt: string;
}

export interface StagePersistedState {
  stage: PlanningStage;
  /** 已接受并写入成功的模块集合。 */
  accepted: ModulePersistedState[];
  /** 失败 / 拒绝的模块；用于 UI 显示「缺失 / 被拒」。 */
  rejected: ModulePersistedState[];
  /** 该阶段累计尝试次数；超过 retry-limit 时进入 needs_user。 */
  attempts: number;
  /** 阶段最近一次失败原因。 */
  lastError?: PlanningStageError;
  /** 阶段最近一次成功时间。 */
  updatedAt: string;
}

export interface PlanningGenerationState {
  projectId: string;
  /** 当前正在运行或下一个要跑的阶段。 */
  currentStage: PlanningStage;
  /** 已完成阶段；这些阶段不会被重跑。 */
  completedStages: PlanningStage[];
  /** 各阶段状态（按 stage 索引）。 */
  stages: StagePersistedState[];
  /** 上次成功的 AI 回复（结构化），用于 UI 显示「已接受」。 */
  lastAssistantReply?: string;
  /** 上次结构化输出的 module 摘要，方便 UI 直接读。 */
  lastModuleSummary?: ModuleOutcome[];
  /** 上次结构化输出的「缺失模块」摘要，方便系统回复用户。 */
  lastMissingSummary?: string[];
  /** 整体状态：pending → running → needs_user | completed | failed */
  status: "pending" | "running" | "needs_user" | "completed" | "failed";
  /** 续跑锚点：上次完成到哪个 stage。重启后 orchestrator 从 currentStage 开始。 */
  resumeAt: string;
  /** Provider 标签：仅用于日志和 UI 显示「上一轮跑的是哪个 provider」；
   *  prompt / schema / validator 永远不允许依赖这个值。 */
  providerLabel?: string;
}

// ──────────────────────────────────────────────────────────────────────────
// 规划器接口：provider-neutral。任何 adapter 必须实现该接口；orchestrator
// 只能调用接口方法，不能直接判断 provider / model。
// ──────────────────────────────────────────────────────────────────────────
export interface PlannerContext {
  /** 已固化的项目骨架（destination / days / nights / productForm / sales）。 */
  skeleton: PlanningSkeleton;
  /** 当前产品草稿（来自数据库），用于 incremental 合并。 */
  currentProduct: Record<string, unknown>;
  /** 已接受的模块（来自 generation state），用于 incremental 输入。 */
  acceptedModules: PlanningGenerationState["stages"][number]["accepted"];
  /** 已声明的 research tasks（用于「避免重复添加」）。 */
  existingResearchTasks: Array<Pick<ResearchTaskProposal, "label" | "type">>;
  /** 历史会话（只用于补充上下文；orchestrator 不依赖它做决策）。 */
  history: Array<{ role: "user" | "assistant"; content: string }>;
  /** Provider / model 仅作为 transport 参数，schema / prompt 不依赖。 */
  transport: {
    providerLabel: string;
    model: string;
  };
}

/** 骨架字段；AI 不能修改，只能填占位。 */
export interface PlanningSkeleton {
  destination: string;
  days: number;
  nights: number;
  productForm: "privateTour" | "groupTour";
  productType: "domesticShort" | "domesticLong";
  /** 系统生成的供应商产品编号（AI 不可修改）。 */
  supplierProductCode: string;
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
}

/**
 * 统一错误类。orchestrator 根据 code 决定是否重试；不暴露 provider 细节。
 */
export class PlannerError extends Error {
  constructor(
    public readonly code:
      | "provider_not_configured"
      | "provider_connection"
      | "provider_timeout"
      | "provider_rate_limit"
      | "provider_authentication"
      | "invalid_model_output"
      | "empty_model_output"
      | "missing_module"
      | "rejected_path"
      | "unknown",
    message: string,
    public readonly details?: string,
  ) {
    super(message);
  }
}