/**
 * Planning 模块契约：
 *   - PlanningModule / REQUIRED_MODULES：模块白名单；
 *   - ModuleStatus / ModuleOutcome：模块级裁决 + 写入路径约束；
 *   - ResearchTaskProposal：research 模块的研究任务提案结构。
 *
 * "不允许任意路径 / 不允许 RFC6902"是这个模块的核心约束，UI 借这个类型
 * 拒绝 free-form 写盘。
 */

/**
 * 每个阶段会落盘若干模块；模块是「产品 JSON 里的一个子树」或
 * 「一组运营数据」。系统只接受规划子系统显式声明的模块，不接受任意路径。
 */
export type PlanningModule =
  | "basicInfo"
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
  "basicInfo",
  "presentation",
  "itinerary",
  "packageName",
  "pricing",
  "inventory",
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