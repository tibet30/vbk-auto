/**
 * 三阶段行程编排（foundationLocation / verifiedPool / composeItinerary）
 * 的依赖类型 + 内部小工具 + 通用 helper。
 *
 * 私有符号（fail / node / asRecord / text / errorMessage / poolSummary /
 * alternativeCandidateKey）从父文件带过来，所有子文件按需 import。
 */

import type {
  PlanningNodeId,
  PlanningNodeState,
  PlanningPlanV2,
  PlanningPoiCandidate,
  PlanningSkeleton,
  ThreeStagePlanningAi,
} from "../../../shared/contracts-planning.js";
import type { PoiSuggestDetailResult } from "../../../shared/contracts-types.js";
import type { OrchestratorRuntime } from "../types.js";

export interface ThreeStageItineraryDependencies {
  localProductId: string;
  skeleton: PlanningSkeleton & { province: string; city: string };
  ai: ThreeStagePlanningAi;
  runtime: OrchestratorRuntime;
  assertVbkLogin(): Promise<void>;
  queryPoi(name: string): Promise<PoiSuggestDetailResult>;
}

export type PatchNode = (id: PlanningNodeId, patch: Partial<PlanningNodeState>) => Promise<void>;

/** 把任意值折叠成顶层 keys object；非对象/null/数组 → null。 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** 任意值归一为字符串（trim）；非 string 视为 ""。 */
export function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 错误对象 → message 字符串；非 Error 走 String(error)。 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 从 plan.nodes 中读取指定 id 的节点状态；未找到（非程序约束）视作 undefined 抛出。 */
export function node(plan: PlanningPlanV2, id: PlanningNodeId): PlanningNodeState {
  return plan.nodes.find((entry) => entry.id === id)!;
}

/** 阶段失败收尾：把当前节点打 failed，并把整 plan 标记为 needs_user 让上层 UI 接管。 */
export async function fail(patchNode: PatchNode, getPlan: () => PlanningPlanV2, id: PlanningNodeId, error: string) {
  await patchNode(id, { status: "failed", error });
  return { ok: false, plan: { ...getPlan(), status: "needs_user" as const, currentNode: id } };
}

/** POI 池简报：UI 文本「推荐 X / 命中 Y」。 */
export function poolSummary(plan: PlanningPlanV2): string {
  return `推荐 ${plan.poiCandidates.length} / 命中 ${plan.poiCandidates.filter((item) => item.status === "resolved").length}`;
}

/** 多选/可选项候选的稳定指纹：用于去重合并 alternative 集合。 */
export function alternativeCandidateKey(candidate: PlanningPoiCandidate): string {
  return [
    candidate.userActivityId || "",
    candidate.selectedAlternativeIndex ?? "",
    candidate.poiId ?? "",
    candidate.requestedName,
  ].join("|");
}