import { PLANNING_STAGE_RETRY_LIMIT, type PlanningNodeId, type PlanningNodeState, type PlanningPlanV2, type PlanningPoiCandidate, type PlanningSkeleton, type ThreeStagePlanningAi } from "../../shared/contracts-planning.js";
import { emptyPlanningUserIntent } from "../../shared/contracts-planning-intent.js";
import type { PoiSuggestDetailResult } from "../../shared/contracts-types.js";
import { toPlatformShortLocationName } from "../../shared/location-short-name.js";
import { AI_WRITABLE_PATHS } from "./schemas.js";
import { expandVerifiedItinerary, resolvePlanningPoiCandidates } from "./planning-v2-pois.js";
import type { OrchestratorRuntime } from "./types.js";
import { isAcceptablePlanningRegionName, normaliseProvinceName } from "./runtime.js";
import { findAllVbkCopyBadCases } from "./vbk-copy-policy.js";
import { blockingUserPoiFailure, userPoiCandidateSeeds } from "./user-intent.js";

export interface ThreeStageItineraryDependencies {
  localProductId: string;
  skeleton: PlanningSkeleton & { province: string; city: string };
  ai: ThreeStagePlanningAi;
  runtime: OrchestratorRuntime;
  assertVbkLogin(): Promise<void>;
  queryPoi(name: string): Promise<PoiSuggestDetailResult>;
}

type PatchNode = (id: PlanningNodeId, patch: Partial<PlanningNodeState>) => Promise<void>;

/** 第一阶段只补齐省份；城市在创建时锁定，AI 不得覆盖。 */
export async function runFoundationLocation(
  deps: ThreeStageItineraryDependencies,
  initial: PlanningPlanV2,
  patchNode: PatchNode,
  getPlan: () => PlanningPlanV2,
): Promise<{ ok: boolean; plan: PlanningPlanV2 }> {
  let plan = initial;
  let previousError: { stage: "basicInfo"; attempt: number; code: string; message: string } | undefined;
  for (let attempt = 1; attempt <= PLANNING_STAGE_RETRY_LIMIT; attempt += 1) {
    await patchNode("skeleton", { status: "running", attempts: attempt, startedAt: new Date().toISOString(), error: undefined });
    plan = getPlan();
    try {
      const currentProduct = await deps.runtime.loadCurrentProduct(deps.localProductId);
      const currentBasic = asRecord(currentProduct.basicInfo) ?? {};
      const currentCity = toPlatformShortLocationName(
        text(currentBasic.meetingCity) || text(currentBasic.destinationCity) || deps.skeleton.city,
      );
      const location = await deps.ai.structureLocation({
        destination: deps.skeleton.destination,
        currentProvince: text(currentBasic.province),
        currentDestinationCity: currentCity,
        previousError: previousError?.message,
      });
      const province = normaliseProvinceName(text(location.province));
      const errors: string[] = [];
      if (!province) errors.push("province 为空");
      else if (!isAcceptablePlanningRegionName(province, currentCity)) {
        errors.push(`province「${province}」不是可用的国家、地区或一级行政区名称`);
      }
      if (errors.length === 0) {
        const write = await deps.runtime.writeModule(
          deps.localProductId, "basicInfo", AI_WRITABLE_PATHS.basicInfo, { province },
        );
        if (!write.ok) throw new Error(write.reason || "标准目的地写入失败");
        deps.skeleton.province = province;
        deps.skeleton.city = currentCity;
        await patchNode("skeleton", {
          status: "completed", attempts: attempt, summary: `${province} · ${currentCity} · ${deps.skeleton.days}天`,
          error: undefined, completedAt: new Date().toISOString(),
        });
        return { ok: true, plan: getPlan() };
      }
      previousError = { stage: "basicInfo", attempt, code: "location_gate_failed", message: `第一阶段目的地准入失败：${errors.join("；")}` };
      await patchNode("skeleton", { status: "failed", attempts: attempt, error: previousError.message });
    } catch (error) {
      previousError = { stage: "basicInfo", attempt, code: "location_generation_failed", message: errorMessage(error) };
      await patchNode("skeleton", { status: "failed", attempts: attempt, error: previousError.message });
    }
    plan = getPlan();
  }
  return fail(patchNode, getPlan, "skeleton", previousError?.message ?? "第一阶段目的地准入失败");
}

export async function buildVerifiedPool(
  deps: ThreeStageItineraryDependencies,
  initial: PlanningPlanV2,
  patchNode: PatchNode,
  getPlan: () => PlanningPlanV2,
  setPlan: (plan: PlanningPlanV2) => void,
): Promise<{ ok: boolean; plan: PlanningPlanV2 }> {
  let plan = initial;
  const userIntent = plan.userIntent ?? emptyPlanningUserIntent();
  const existingActivityIds = new Set(plan.poiCandidates.map((candidate) => candidate.userActivityId).filter(Boolean));
  const userSeeds = userPoiCandidateSeeds(userIntent).filter((candidate) => !existingActivityIds.has(candidate.userActivityId));
  if (userSeeds.length) {
    plan = { ...plan, poiCandidates: [...plan.poiCandidates, ...userSeeds] };
    setPlan(plan);
  }
  const plannedDays = new Set(userIntent.activities.filter((activity) => activity.day > 0).map((activity) => activity.day));
  const hardMinimum = Math.max(0, deps.skeleton.days - plannedDays.size);
  const target = Math.min(30, Math.max(10, deps.skeleton.days * 2));
  const recommendationTarget = Math.min(30, Math.max(10, deps.skeleton.days * 3));

  const pendingAtResume = plan.poiCandidates.filter((item) => item.status === "proposed");
  if (pendingAtResume.length) {
    const resolved = await resolveCandidates(deps, pendingAtResume, plan, setPlan);
    if (!resolved.ok) {
      await patchNode("poiResolution", { status: "blocked", attempts: node(plan, "poiResolution").attempts, error: resolved.error });
      return { ok: false, plan: getPlan() };
    }
    plan = resolved.plan;
    await patchNode("poiResolution", {
      status: "completed", attempts: Math.max(1, node(plan, "poiResolution").attempts),
      summary: poolSummary(plan), error: undefined, completedAt: new Date().toISOString(),
    });
    plan = getPlan();
    const userFailure = blockingUserPoiFailure(plan.poiCandidates);
    if (userFailure) return fail(patchNode, getPlan, "poiResolution", userFailure);
  }

  for (let round = node(plan, "spotCandidates").attempts + 1; round <= PLANNING_STAGE_RETRY_LIMIT; round += 1) {
    const resolved = plan.poiCandidates.filter((item) => item.status === "resolved");
    if (resolved.length >= target) break;
    const seen = plan.poiCandidates.map((item) => item.requestedName);
    await patchNode("spotCandidates", { status: "running", attempts: round, startedAt: new Date().toISOString(), error: undefined });
    plan = getPlan();
    let names: string[];
    try {
      names = await deps.ai.recommendSpotNames({
        destination: deps.skeleton.destination, province: deps.skeleton.province, city: deps.skeleton.city,
        days: deps.skeleton.days,
        targetCount: round === 1 ? recommendationTarget : Math.min(30 - seen.length, Math.max(1, target - resolved.length)),
        excludedNames: seen,
        rejectedNames: plan.poiCandidates.filter((item) => item.status === "rejected").map((item) => item.requestedName),
        userIdea: userIntent.rawIdea || undefined, userIntent,
      });
    } catch (error) {
      const message = errorMessage(error);
      await patchNode("spotCandidates", { status: "failed", attempts: round, error: message });
      plan = getPlan();
      if (resolved.length >= hardMinimum) {
        await patchNode("spotCandidates", {
          status: "completed", attempts: round, summary: `已有 ${resolved.length} 个真实 POI，跳过本轮补充推荐`,
          error: undefined, completedAt: new Date().toISOString(),
        });
        plan = getPlan();
        break;
      }
      if (round === PLANNING_STAGE_RETRY_LIMIT) return fail(patchNode, getPlan, "spotCandidates", message);
      continue;
    }
    const newEntries = names.map((requestedName) => ({ requestedName, status: "proposed" as const, source: "ai" as const }));
    plan = { ...getPlan(), poiCandidates: [...getPlan().poiCandidates, ...newEntries] };
    setPlan(plan);
    await patchNode("spotCandidates", { status: "completed", attempts: round, summary: `累计推荐 ${plan.poiCandidates.length} 个候选`, completedAt: new Date().toISOString() });
    plan = getPlan();

    const unresolved = plan.poiCandidates.filter((item) => item.status === "proposed");
    const checked = await resolveCandidates(deps, unresolved, plan, setPlan);
    if (!checked.ok) {
      await patchNode("poiResolution", { status: "blocked", attempts: round - 1, error: checked.error });
      return { ok: false, plan: getPlan() };
    }
    plan = checked.plan;
    await patchNode("poiResolution", { status: "completed", attempts: round, summary: poolSummary(plan), error: undefined, completedAt: new Date().toISOString() });
    plan = getPlan();
  }
  const hit = plan.poiCandidates.filter((item) => item.status === "resolved").length;
  const userFailure = blockingUserPoiFailure(plan.poiCandidates);
  if (userFailure) return fail(patchNode, getPlan, "poiResolution", userFailure);
  if (hit >= hardMinimum && node(plan, "spotCandidates").status === "failed") {
    await patchNode("spotCandidates", { status: "completed", summary: `已有 ${hit} 个真实 POI，满足最低准入门槛`, error: undefined, completedAt: new Date().toISOString() });
    plan = getPlan();
  }
  if (hit < hardMinimum) return fail(patchNode, getPlan, "poiResolution", `真实 POI 仅 ${hit} 个，少于 ${hardMinimum} 天的最低门槛`);
  return { ok: true, plan };
}

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

async function resolveCandidates(
  deps: ThreeStageItineraryDependencies,
  candidates: PlanningPoiCandidate[],
  plan: PlanningPlanV2,
  setPlan: (plan: PlanningPlanV2) => void,
): Promise<{ ok: true; plan: PlanningPlanV2 } | { ok: false; error: string }> {
  try {
    const checked = await resolvePlanningPoiCandidates({
      names: candidates.map((item) => item.requestedName), province: deps.skeleton.province,
      city: deps.skeleton.city, concurrency: 5, beforeEach: deps.assertVbkLogin, query: deps.queryPoi,
      checkAvailability: deps.runtime.getPoiAvailability?.bind(deps.runtime),
      destination: deps.skeleton.destination,
      userIdea: plan.userIntent?.rawIdea,
      shouldDisambiguate: (_requestedName, index) => candidates[index]?.source === "user",
      preferredDay: (_requestedName, index) => candidates[index]?.preferredDay,
      ...(deps.ai.disambiguatePoiCandidate
        ? { disambiguate: deps.ai.disambiguatePoiCandidate.bind(deps.ai) }
        : {}),
    });
    const byName = new Map(checked.map((item) => [item.requestedName, item]));
    const next = { ...plan, poiCandidates: plan.poiCandidates.map((item) => {
      const result = byName.get(item.requestedName);
      return result ? { ...item, ...result } : item;
    }) };
    setPlan(next);
    return { ok: true, plan: next };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

async function fail(patchNode: PatchNode, getPlan: () => PlanningPlanV2, id: PlanningNodeId, error: string) {
  await patchNode(id, { status: "failed", error });
  return { ok: false, plan: { ...getPlan(), status: "needs_user" as const, currentNode: id } };
}

function poolSummary(plan: PlanningPlanV2): string {
  return `推荐 ${plan.poiCandidates.length} / 命中 ${plan.poiCandidates.filter((item) => item.status === "resolved").length}`;
}

function node(plan: PlanningPlanV2, id: PlanningNodeId): PlanningNodeState {
  return plan.nodes.find((entry) => entry.id === id)!;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
