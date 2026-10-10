/**
 * 产品契约：列表 / 详情 / 创建入参 / readiness 概览；
 * 也包含 AI 用量与 planning run 实时快照引用（不在本文件定义）。
 */

import type { ProductWorkflowTask } from "./workflow.js";
import type { ResearchTask, ConversationMessage } from "./conversation.js";
import type { AutomationRun } from "./automation.js";
import type { PhaseRecovery } from "./advisor.js";

export interface ProductSummary {
  id: string;
  name: string;
  status: "planning" | "review" | "automating" | "draft_saved" | "blocked";
  /** Persisted local cover handoff; a real image still blocks no part of this status. */
  coverNeedsReplacement?: boolean;
  productId?: string;
  /** 创建该产品时使用的 VBK 登录账号（例如 vbk_671205）。 */
  vbkAccount?: string;
  updatedAt: string;
  revision?: number;
  /** 本机最近一条一键创建任务；不写入 Tibet 产品业务快照。 */
  workflowTask?: ProductWorkflowTask;
  /** 本机执行耗时，不进入产品业务数据。 */
  executionTime?: import("../product-execution-time.js").ProductExecutionTime;
}

export interface CreateProductInput {
  destination: string;
  days: number;
  productForm: import("../product-form.js").ProductForm;
  /** 创建产品时用户提供的原始想法，供后续 AI 规划参考。 */
  userIdea?: string;
  /** 勾选后由主进程完成生成、核验和 VBK 自动录入，不依赖 renderer 持续在线。 */
  autoConfirm?: boolean;
}

export interface ProductReadiness {
  ready: boolean;
  completion: number;
  issues: Array<{ label: string; detail: string }>;
}

export interface ProductDetail extends ProductSummary {
  product: Record<string, unknown>;
  messages: ConversationMessage[];
  researchTasks: ResearchTask[];
  automation?: AutomationRun;
  /** 本地 product_json 乐观并发版本；崩溃恢复后用于拒绝过期整包覆盖。 */
  productJsonVersion?: number;
  /** 基本信息是否已在 VBK 成功保存，决定重试时是否需要补跑 basic 阶段。 */
  basicInfoSaved?: boolean;
  planning?: import("../contracts-planning.js").PlanningPlanV2;
  /** 产品级 AI Token 用量；与 planning 同级，在本机持久化，不随诊断上传。 */
  aiUsage?: import("../contracts-ai-usage.js").ProductAiUsage;
  /** 单阶段恢复尝试的索引；运行时挂在 product 之外的字段（最近一次 advisor 出口）。 */
  recovery?: { phases: Record<string, PhaseRecovery> };
}