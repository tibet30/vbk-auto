/**
 * itinerary-adoption 状态机：
 *   - markItineraryPendingAdoption：仅由 itinerary patch 调用，让旧 completion 明确
 *     失效，并等待运营采用（userRecommendedSpotNames 会跨 revision 保留以避免误丢）；
 *   - markItineraryVerifying：进入 verifications → poiResolution running；
 *   - markItineraryBlocked：poiResolution status=blocked，adoption.status=blocked，
 *     其他 itinerary / completion 节点 invalidated；
 *   - markItineraryAccepted：从当前 itinerary 抽取已核验 POI → 写入 poiCandidates，
 *     已被 POI 的 count + manual count 写入 poiResolution summary，adoption.status=accepted；
 *   - hasPendingItineraryAdoption / isPlanningRunInProgress：状态查询；
 *   - guardLatestItineraryAdoption：旧 POI 查询返回后检查最新快照，阻止旧路线覆盖
 *     新版路线（fingerprint 不一致 / adoption.status 不再是 verifying）。
 */

import type { ItineraryAdoptionState, PlanningPlanV2 } from "../../../shared/contracts-planning.js";
import {
  COMPLETION_NODES,
  HOTEL_RESOLUTION_NODE,
  ITINERARY_NODES,
  invalidateItineraryNode,
} from "./utils.js";
import { itineraryFingerprint } from "./fingerprint.js";
import { collectRequiredItinerarySpots } from "./spots.js";
import { asRecord, positiveInteger, text } from "./utils.js";

export type ItineraryAdoptionGuard = { ok: true } | { ok: false; reason: "itinerary_changed" | "adoption_state_changed" };

export function markItineraryPendingAdoption(
  plan: PlanningPlanV2,
  itinerary: unknown,
  now = new Date().toISOString(),
  userRecommendedSpotNames?: readonly string[],
): PlanningPlanV2 {
  const revision = itineraryFingerprint(itinerary);
  const preservedNames = plan.itineraryAdoption?.itineraryRevision === revision
    ? plan.itineraryAdoption.userRecommendedSpotNames
    : undefined;
  const adoption: ItineraryAdoptionState = {
    status: "pending",
    itineraryRevision: revision,
    triggeredAt: now,
    userRecommendedSpotNames: [...new Set(userRecommendedSpotNames ?? preservedNames ?? [])],
  };
  const nodes = plan.nodes.map((node) => {
    if (COMPLETION_NODES.has(node.id)) return invalidateItineraryNode(node);
    if (node.id === "poiResolution") return completeNode(node);
    if (node.id === "itineraryDraft") return completeNode(node);
    if (node.id === HOTEL_RESOLUTION_NODE) return invalidateItineraryNode(node);
    return node;
  });
  return {
    ...plan,
    status: "needs_user",
    currentNode: "poiResolution",
    nodes,
    itineraryAdoption: adoption,
    updatedAt: now,
  };
}

function completeNode(node: PlanningPlanV2["nodes"][number]) {
  return {
    ...node,
    status: "completed" as const,
    attempts: 0,
    startedAt: undefined,
    completedAt: undefined,
    error: undefined,
    summary: undefined,
  };
}

export function markItineraryVerifying(plan: PlanningPlanV2, itinerary: unknown, now = new Date().toISOString()): PlanningPlanV2 {
  return {
    ...plan,
    status: "running",
    currentNode: "poiResolution",
    nodes: plan.nodes.map((node) => node.id === "poiResolution"
      ? {
        ...invalidateItineraryNode(node),
        status: "running" as const,
        startedAt: now,
      }
      : node),
    itineraryAdoption: {
      status: "verifying",
      itineraryRevision: itineraryFingerprint(itinerary),
      triggeredAt: plan.itineraryAdoption?.triggeredAt ?? now,
      userRecommendedSpotNames: plan.itineraryAdoption?.userRecommendedSpotNames,
    },
    updatedAt: now,
  };
}

export function markItineraryBlocked(plan: PlanningPlanV2, itinerary: unknown, error: string, now = new Date().toISOString()): PlanningPlanV2 {
  return {
    ...plan,
    status: "needs_user",
    currentNode: "poiResolution",
    nodes: plan.nodes.map((node) => ITINERARY_NODES.has(node.id) || node.id === HOTEL_RESOLUTION_NODE || COMPLETION_NODES.has(node.id)
      ? {
        ...invalidateItineraryNode(node),
        status: node.id === "poiResolution" ? "blocked" as const : "invalidated" as const,
        error: node.id === "poiResolution" ? error : undefined,
      }
      : node),
    itineraryAdoption: {
      status: "blocked",
      itineraryRevision: itineraryFingerprint(itinerary),
      triggeredAt: plan.itineraryAdoption?.triggeredAt ?? now,
      userRecommendedSpotNames: plan.itineraryAdoption?.userRecommendedSpotNames,
      error,
    },
    updatedAt: now,
  };
}

export function markItineraryAccepted(plan: PlanningPlanV2, itinerary: unknown, now = new Date().toISOString()): PlanningPlanV2 {
  const selectedAt = now;
  const required = collectRequiredItinerarySpots(itinerary).filter((spot) => !spot.travelNode);
  const candidates = new Map<string, PlanningPlanV2["poiCandidates"][number]>();
  let matchedCount = 0;
  for (const spot of required) {
    const day = asRecord(Array.isArray(itinerary) ? itinerary[spot.dayIndex] : undefined);
    const value = asRecord(Array.isArray(day?.spots) ? day.spots[spot.spotIndex] : undefined);
    if (text(value?.poiName) && positiveInteger(value?.poiId)) {
      matchedCount += 1;
      candidates.set(spot.name, {
        requestedName: spot.name,
        status: "selected",
        poiName: text(value.poiName),
        poiId: value.poiId,
      });
    } else if (candidates.get(spot.name)?.status !== "selected") {
      candidates.set(spot.name, {
        requestedName: spot.name,
        status: "rejected",
        reason: "未匹配真实 POI，保留用户推荐景点，待运营手动配置",
      });
    }
  }
  const manualCount = required.length - matchedCount;
  return {
    ...plan,
    status: "pending",
    currentNode: "copy",
    nodes: plan.nodes.map((node) => {
      if (COMPLETION_NODES.has(node.id)) return invalidateItineraryNode(node);
      if (node.id === HOTEL_RESOLUTION_NODE) return invalidateItineraryNode(node);
      if (!ITINERARY_NODES.has(node.id)) return node;
      return {
        ...node,
        status: "completed" as const,
        attempts: Math.max(1, node.attempts),
        startedAt: undefined,
        error: undefined,
        summary: node.id === "poiResolution"
          ? `已匹配 ${matchedCount}/${required.length} 个真实 POI${manualCount > 0 ? `，${manualCount} 个待手动配置` : ""}`
          : "已采用当前对话行程",
        completedAt: selectedAt,
      };
    }),
    poiCandidates: [...candidates.values()],
    itineraryAdoption: {
      status: "accepted",
      itineraryRevision: itineraryFingerprint(itinerary),
      triggeredAt: plan.itineraryAdoption?.triggeredAt ?? now,
      userRecommendedSpotNames: plan.itineraryAdoption?.userRecommendedSpotNames,
    },
    updatedAt: now,
  };
}

export function hasPendingItineraryAdoption(plan: PlanningPlanV2 | undefined): boolean {
  return plan?.itineraryAdoption?.status === "pending" || plan?.itineraryAdoption?.status === "blocked";
}

export function isPlanningRunInProgress(plan: PlanningPlanV2 | undefined): boolean {
  return plan?.status === "running" || plan?.status === "pending";
}

/** 在旧 POI 查询返回后检查 Tibet 最新快照，阻止旧路线覆盖新版路线。 */
export function guardLatestItineraryAdoption(
  expectedItinerary: unknown,
  latestPlan: PlanningPlanV2 | undefined,
  latestItinerary: unknown,
): ItineraryAdoptionGuard {
  const expected = itineraryFingerprint(expectedItinerary);
  if (itineraryFingerprint(latestItinerary) !== expected) return { ok: false, reason: "itinerary_changed" };
  if (latestPlan?.itineraryAdoption?.status !== "verifying"
    || latestPlan.itineraryAdoption.itineraryRevision !== expected) {
    return { ok: false, reason: "adoption_state_changed" };
  }
  return { ok: true };
}