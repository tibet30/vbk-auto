/**
 * 第二阶段：构建真实 POI 候选池。
 *
 * 三件事：
 *   1) 先把 user intent 中的「逐日活动」按 day 与 preferredDay 落到种子候选
 *      （已在 set 中跳过重复）；
 *   2) 处理上次中断留下的 proposed 候选（resolveCandidates 同步刷真实 POI
 *      命中 + 拒绝原因）；
 *   3) 当 resolved 数量不达 target 时，启动多轮 AI 推荐 + resolve，
 *      每轮都把 resolved 数与最低门槛 hardMinimum 对齐，
 *      hardMinimum = max(0, days - plannedDays.size)。
 */

import { PLANNING_STAGE_RETRY_LIMIT, type PlanningPlanV2, type PlanningPoiCandidate } from "../../../shared/contracts-planning.js";
import { emptyPlanningUserIntent } from "../../../shared/contracts-planning-intent.js";
import { resolvePlanningPoiCandidates } from "../planning-v2-pois.js";
import { logPlanningPoiEvent } from "../planning-poi-resolver.js";
import { blockingUserPoiFailure, hasCompleteDailyUserItinerary, userPoiCandidateSeeds } from "../user-intent.js";
import type { PatchNode, ThreeStageItineraryDependencies } from "./types.js";
import { alternativeCandidateKey, errorMessage, fail, node, poolSummary } from "./types.js";

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
  const skipAiRecommendations = hasCompleteDailyUserItinerary(userIntent, deps.skeleton.days);
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
    const userFailure = blockingUserPoiFailure(plan.poiCandidates, userIntent);
    if (userFailure) return fail(patchNode, getPlan, "poiResolution", userFailure);
  }

  if (skipAiRecommendations) {
    await patchNode("spotCandidates", {
      status: "skipped",
      summary: "用户已逐日指定行程，跳过 AI 推荐景点",
      completedAt: new Date().toISOString(),
    });
    plan = getPlan();
  }

  const firstRecommendationRound = skipAiRecommendations
    ? PLANNING_STAGE_RETRY_LIMIT + 1
    : node(plan, "spotCandidates").attempts + 1;
  for (let round = firstRecommendationRound; round <= PLANNING_STAGE_RETRY_LIMIT; round += 1) {
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
  const userFailure = blockingUserPoiFailure(plan.poiCandidates, userIntent);
  if (userFailure) return fail(patchNode, getPlan, "poiResolution", userFailure);
  if (hit >= hardMinimum && node(plan, "spotCandidates").status === "failed") {
    await patchNode("spotCandidates", { status: "completed", summary: `已有 ${hit} 个真实 POI，满足最低准入门槛`, error: undefined, completedAt: new Date().toISOString() });
    plan = getPlan();
  }
  if (hit < hardMinimum) return fail(patchNode, getPlan, "poiResolution", `真实 POI 仅 ${hit} 个，少于 ${hardMinimum} 天的最低门槛`);
  return { ok: true, plan };
}

/**
 * 一次性的"批查"：把一批 proposed 候选交给 resolvePlanningPoiCandidates 真实
 * POI 匹配，再叠加 user-intent 多选项（alternativeNames）的解析。失败 → 返回
 * `{ ok: false, error }`；成功 → 把最新 candidates 写入 plan 并返回新 plan。
 *
 * 日志统一打"批次汇总"，warn 仅在出现 rejected 时触发，避免大量 OK 信息淹没
 * 关键失败信号。
 */
export async function resolveCandidates(
  deps: ThreeStageItineraryDependencies,
  candidates: PlanningPoiCandidate[],
  plan: PlanningPlanV2,
  setPlan: (plan: PlanningPlanV2) => void,
): Promise<{ ok: true; plan: PlanningPlanV2 } | { ok: false; error: string }> {
  try {
    let checked = await resolvePlanningPoiCandidates({
      names: candidates.map((item) => item.requestedName), province: deps.skeleton.province,
      city: deps.skeleton.city, concurrency: 5, beforeEach: deps.assertVbkLogin, query: deps.queryPoi,
      checkAvailability: deps.runtime.getPoiAvailability?.bind(deps.runtime),
      destination: deps.skeleton.destination,
      userIdea: plan.userIntent?.rawIdea,
      shouldDisambiguate: (_requestedName, index) => candidates[index]?.source === "user",
      preferredDay: (_requestedName, index) => candidates[index]?.preferredDay,
      ...(deps.ai.correctPoiName ? { correctName: deps.ai.correctPoiName.bind(deps.ai) } : {}),
      logContext: { localProductId: deps.localProductId },
      ...(deps.ai.disambiguatePoiCandidate
        ? { disambiguate: deps.ai.disambiguatePoiCandidate.bind(deps.ai) }
        : {}),
    });
    const withAlternatives = await resolveUserPoiAlternatives(deps, candidates, checked, plan);
    checked = withAlternatives.checked;
    const updatedCandidates = plan.poiCandidates.map((item) => {
      const index = candidates.indexOf(item);
      return index < 0 ? item : { ...item, ...checked[index] };
    });
    const existingAlternativeKeys = new Set(updatedCandidates.map(alternativeCandidateKey));
    const appendedAlternatives = withAlternatives.additional.filter((item) => {
      const key = alternativeCandidateKey(item);
      if (existingAlternativeKeys.has(key)) return false;
      existingAlternativeKeys.add(key);
      return true;
    });
    const next = {
      ...plan,
      poiCandidates: [...updatedCandidates, ...appendedAlternatives],
    };
    logPlanningPoiEvent({ localProductId: deps.localProductId }, "批次汇总", {
      target: candidates.map((item) => item.requestedName).join("、"),
      total: checked.length,
      resolved: checked.filter((item) => item.status === "resolved").length,
      rejected: checked.filter((item) => item.status === "rejected").length,
      results: checked.map((item) => ({ requestedName: item.requestedName, status: item.status, poiName: item.poiName, reason: item.reason })),
    }, checked.some((item) => item.status === "rejected") ? "warn" : "info");
    setPlan(next);
    return { ok: true, plan: next };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/**
 * "二选一/或者"在平台录入里按同日并列备选处理：每个用户给出的选项都做
 * 同一套真实 POI、地域和营业校验，可用项全部保留给行程录入。
 */
export async function resolveUserPoiAlternatives(
  deps: ThreeStageItineraryDependencies,
  candidates: PlanningPoiCandidate[],
  checked: PlanningPoiCandidate[],
  plan: PlanningPlanV2,
): Promise<{ checked: PlanningPoiCandidate[]; additional: PlanningPoiCandidate[] }> {
  const next = [...checked];
  const additional: PlanningPoiCandidate[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const first = checked[index];
    const alternatives = candidate.alternativeNames?.slice(1) ?? [];
    if (candidate.source !== "user" || !first || alternatives.length === 0) continue;
    logPlanningPoiEvent({ localProductId: deps.localProductId }, "多选项核验开始", {
      target: candidate.requestedName, alternatives, firstStatus: first.status, firstReason: first.reason,
    });
    const fallbacks = await resolvePlanningPoiCandidates({
      names: alternatives, province: deps.skeleton.province, city: deps.skeleton.city, concurrency: Math.min(5, alternatives.length),
      beforeEach: deps.assertVbkLogin, query: deps.queryPoi,
      checkAvailability: deps.runtime.getPoiAvailability?.bind(deps.runtime),
      destination: deps.skeleton.destination, userIdea: plan.userIntent?.rawIdea,
      shouldDisambiguate: () => true,
      preferredDay: () => candidate.preferredDay,
      ...(deps.ai.correctPoiName ? { correctName: deps.ai.correctPoiName.bind(deps.ai) } : {}),
      logContext: { localProductId: deps.localProductId },
      ...(deps.ai.disambiguatePoiCandidate ? { disambiguate: deps.ai.disambiguatePoiCandidate.bind(deps.ai) } : {}),
    });
    const ranked = [first, ...fallbacks].map((option, selectedAlternativeIndex) => ({ option, selectedAlternativeIndex }));
    const usable = ranked.filter((item) => item.option.status === "resolved");
    if (usable.length > 0) {
      const names = usable.map((item) => item.option.poiName || item.option.requestedName).join("、");
      const [primary, ...rest] = usable;
      next[index] = {
        ...primary.option,
        alternativeNames: candidate.alternativeNames,
        selectedAlternativeIndex: primary.selectedAlternativeIndex,
      };
      additional.push(...rest.map((item) => ({
        ...item.option,
        source: "user" as const,
        userActivityId: candidate.userActivityId,
        preferredDay: candidate.preferredDay,
        alternativeNames: candidate.alternativeNames,
        selectedAlternativeIndex: item.selectedAlternativeIndex,
        reason: `同组备选 POI：${candidate.alternativeNames?.join("或")}`,
      })));
      logPlanningPoiEvent({ localProductId: deps.localProductId }, "多选项核验保留", {
        target: candidate.requestedName, usable: names, count: usable.length,
      });
    } else {
      const details = ranked.map((item) => {
        const label = item.selectedAlternativeIndex === 0
          ? candidate.requestedName
          : alternatives[item.selectedAlternativeIndex - 1] || item.option.requestedName;
        return `「${label}」${item.option.reason || "不可用"}`;
      });
      next[index] = {
        ...first,
        status: "rejected",
        alternativeNames: candidate.alternativeNames,
        reason: `候选地点均不可用：${details.join("；")}。请补充可替换的地点，或其他安排意见。`,
      };
      logPlanningPoiEvent({ localProductId: deps.localProductId }, "多选项均不可用", {
        target: candidate.requestedName, reason: next[index].reason,
      }, "warn");
    }
    for (const [offset, fallback] of fallbacks.entries()) {
      if (fallback.status !== "resolved") {
        const name = alternatives[offset];
        logPlanningPoiEvent({ localProductId: deps.localProductId }, "备选回退未命中", {
          target: candidate.requestedName, fallbackName: name, selectedAlternativeIndex: offset + 1, reason: fallback.reason,
        }, "warn");
      }
    }
  }
  return { checked: next, additional };
}