/**
 * 第三阶段：把真实 POI 池落盘为 itinerary。
 *
 * 约束：
 *   - 只接受 status === "resolved" 的候选，扩展时再次走 selectedIds；
 *   - 一次失败最多重试 PLANNING_STAGE_RETRY_LIMIT 次；最终失败 → fail()；
 *   - 行程写入前必须通过 VBK 黑名单文案检查；
 *   - 写完后把选中 POI 的 status 标记为 selected，保留"备用 POI"以便二次行程调整。
 */

import { PLANNING_STAGE_RETRY_LIMIT, type PlanningPoiCandidate, type PlanningPlanV2 } from "../../../shared/contracts-planning.js";
import { expandVerifiedItinerary } from "../planning-v2-pois.js";
import { AI_WRITABLE_PATHS } from "../schemas.js";
import { findAllVbkCopyBadCases } from "../vbk-copy-policy.js";
import type { PatchNode, ThreeStageItineraryDependencies } from "./types.js";
import { errorMessage, fail, node } from "./types.js";

export async function composeItinerary(
  deps: ThreeStageItineraryDependencies,
  initial: PlanningPlanV2,
  patchNode: PatchNode,
  getPlan: () => PlanningPlanV2,
  setPlan: (plan: PlanningPlanV2) => void,
): Promise<{ ok: boolean; plan: PlanningPlanV2 }> {
  let plan = initial;
  let previousError = node(plan, "itineraryDraft").error;
  const pool = plan.poiCandidates.filter((item): item is PlanningPoiCandidate & { poiId: number; poiName: string } =>
    item.status === "resolved" && Boolean(item.poiId && item.poiName));
  for (let attempt = node(plan, "itineraryDraft").attempts + 1; attempt <= PLANNING_STAGE_RETRY_LIMIT; attempt += 1) {
    await patchNode("itineraryDraft", { status: "running", attempts: attempt, error: undefined, startedAt: new Date().toISOString() });
    try {
      const drafts = await deps.ai.composeVerifiedItinerary({
        destination: deps.skeleton.destination, days: deps.skeleton.days, candidates: pool, previousError,
        userIdea: plan.userIntent?.rawIdea || undefined, userIntent: plan.userIntent,
      });
      const expanded = expandVerifiedItinerary({ drafts, pool: plan.poiCandidates, days: deps.skeleton.days, userIntent: plan.userIntent });
      if (!expanded.ok) throw new Error(expanded.reason);
      const badCases = findAllVbkCopyBadCases(expanded.itinerary, "itinerary");
      if (badCases.length) throw new Error(badCases.map((entry) =>
        `行程文案 ${entry.path} 命中 VBK 黑名单「${entry.term}」：${entry.reason}；请改写为「${entry.alternatives.join("」或「")}」`,
      ).join("；"));
      const write = await deps.runtime.writeModule(deps.localProductId, "itinerary", AI_WRITABLE_PATHS.itinerary, expanded.itinerary);
      if (!write.ok) throw new Error(write.reason || "行程写入失败");
      plan = {
        ...getPlan(),
        poiCandidates: getPlan().poiCandidates.map((item) => item.poiId && expanded.selectedIds.has(item.poiId)
          ? { ...item, status: "selected" as const } : item),
      };
      setPlan(plan);
      await patchNode("itineraryDraft", {
        status: "completed", attempts: attempt,
        summary: `采用 ${expanded.selectedIds.size} 个真实 POI，生成 ${deps.skeleton.days} 天行程`,
        completedAt: new Date().toISOString(),
      });
      return { ok: true, plan: getPlan() };
    } catch (error) {
      previousError = errorMessage(error);
      await patchNode("itineraryDraft", { status: "failed", attempts: attempt, error: previousError });
      if (attempt === PLANNING_STAGE_RETRY_LIMIT) return fail(patchNode, getPlan, "itineraryDraft", previousError);
    }
  }
  return { ok: false, plan };
}