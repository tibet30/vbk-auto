/**
 * completeness 校验：
 *   - validateCompleteness：从持久化 accepted 模块列表读（runtime.loadAcceptedModules），
 *     对照 REQUIRED_FOR_COMPLETION 判定 missing 模块；返回 accepted / missing / complete；
 *   - requiredModules：导出规范上需要的模块集合（复用于其它模块）；
 *
 * validation 阶段不调用 AI；它只依赖持久化真相，所以重启 / 续跑都能拿到一致结果。
 */

import { REQUIRED_MODULES, type ModuleOutcome, type PlanningModule } from "../../../shared/contracts-planning.js";

export interface ValidationResult {
  missing: ModuleOutcome[];
  accepted: ModuleOutcome[];
  /** 是否满足 completeness。 */
  complete: boolean;
}

export const REQUIRED_FOR_COMPLETION: readonly PlanningModule[] = [
  "basicInfo",
  "presentation",
  "itinerary",
  "packageName",
  "pricing",
  "inventory",
  "release",
];

/**
 * 校验产品规划 completeness：
 *  - 从持久化 accepted 模块列表读（runtime.loadAcceptedModules）；
 *  - 不允许的字段视为缺失；
 *  - 当所有 REQUIRED_FOR_COMPLETION 模块都被标记为 accepted → 完成。
 *
 *  该函数**不会**调用 AI，也不会修改状态；它只报告事实。
 */
export function validateCompleteness(args: {
  acceptedModules: readonly PlanningModule[];
  now?: string;
}): ValidationResult {
  const acceptedSet = new Set(args.acceptedModules);
  const accepted: ModuleOutcome[] = Array.from(acceptedSet).map((module) => ({
    module,
    status: "accepted",
    updatedAt: args.now ?? new Date().toISOString(),
  }));
  const missing: ModuleOutcome[] = REQUIRED_FOR_COMPLETION
    .filter((module) => !acceptedSet.has(module))
    .map((module) => ({
      module,
      status: "missing",
      reason: "validation: 必需模块未落地",
      updatedAt: args.now ?? new Date().toISOString(),
    }));
  return { accepted, missing, complete: missing.length === 0 };
}

export function requiredModules(): readonly PlanningModule[] {
  return REQUIRED_MODULES;
}