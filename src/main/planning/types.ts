/**
 * 规划编排器共享类型与接口定义。
 *
 *  把 OrchestratorRuntime / GenerationStateStore / OrchestratorOptions / 等类型
 *  抽到这里，让 plan-orchestrator.ts 保持薄。
 */

import type {
  PlanningGenerationState,
  PlanningModule,
  Planner,
  PlannerContext,
  ResearchTaskProposal,
} from "../../shared/contracts-planning.js";

export interface OrchestratorRunResult {
  state: PlanningGenerationState;
  /** 系统向 UI / 数据库写入的「assistant 回复」文本（不接受模型声明）。 */
  assistantReply: string;
  /** 实际被接受的模块（来自当前 run + 持久化历史合并）。 */
  accepted: Array<{ module: PlanningModule; status: "accepted"; writePath?: string; acceptedFields?: string[]; missingFields?: string[]; updatedAt: string }>;
  /** 实际被拒绝 / 缺失的模块。 */
  rejected: Array<{ module: PlanningModule; status: "missing" | "rejected"; reason?: string; writePath?: string }>;
  /** 本次新增的 research tasks。 */
  researchTasks: ResearchTaskProposal[];
  /** 该 plan 的最终状态：completed / needs_user / failed。 */
  status: "completed" | "needs_user" | "failed";
}

export interface OrchestratorOptions {
  /** 阶段最大尝试次数（含首次）。默认 3。 */
  stageRetryLimit?: number;
  /** 全部阶段跑完后是否要求 validation 通过；默认 true。 */
  enforceValidation?: boolean;
  /** 实际 provider 标签，仅用于 UI / 日志。 */
  providerLabel?: string;
}

export interface GenerationStateStore {
  load(localProductId: string): Promise<PlanningGenerationState | undefined>;
  save(state: PlanningGenerationState): Promise<void>;
}

export interface OrchestratorRuntime {
  suggestPoi?(keyword: string): Promise<{ poiName: string; poiId: number } | null>;
  /** 读取当前已存在的 research tasks（label+type）。 */
  loadExistingResearchTasks(localProductId: string): Promise<Array<Pick<ResearchTaskProposal, "label" | "type">>>;
  /** 写入一个产品的模块（指定固定路径）。 */
  writeModule(localProductId: string, module: PlanningModule, writePath: string, value: unknown): Promise<{ ok: boolean; reason?: string }>;
  /** 添加一条 research task；返回新增的 id（若 label+type 已存在则返回原 id）。 */
  addResearchTask(localProductId: string, task: ResearchTaskProposal): Promise<string>;
  /** 拉取最近历史对话（仅供 orchestrator 上下文使用）。 */
  loadHistory(localProductId: string): Promise<Array<{ role: "user" | "assistant"; content: string }>>;
  /** 拉取当前产品草稿（用于 orchestrator 的 PlannerContext）。 */
  loadCurrentProduct(localProductId: string): Promise<Record<string, unknown>>;
  /**
   * 加载已 accepted 模块 → 写入的产品 JSON 子树。
   *  Orchestrator 用这个函数从持久化产品中反推「哪个模块已落地」，
   *  从而在续跑 / validation 时判断 completeness —— 不依赖
   *  进程内 in-memory accumulators。
   */
  loadAcceptedModules(localProductId: string): Promise<PlanningModule[]>;
}

export type { Planner, PlannerContext };
