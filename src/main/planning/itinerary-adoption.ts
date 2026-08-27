import { createHash } from "node:crypto";
import type {
  ItineraryAdoptionState,
  PlanningNodeId,
  PlanningPlanV2,
} from "../../shared/contracts-planning.js";

const COMPLETION_NODES = new Set<PlanningNodeId>([
  "copy", "presentation", "commercial", "cover", "vehicleResource", "finalValidation",
]);
const ITINERARY_NODES = new Set<PlanningNodeId>(["poiResolution", "itineraryDraft"]);
const SETTLEMENT_NODE_NAMES = new Set(["四姑娘山镇", "新都桥镇"]);

function invalidateItineraryNode(node: PlanningPlanV2["nodes"][number]) {
  return {
    ...node,
    status: "invalidated" as const,
    attempts: 0,
    startedAt: undefined,
    completedAt: undefined,
    error: undefined,
    summary: undefined,
  };
}

/** 行程内容的稳定指纹，随计划持久化，刷新后仍能判断是否是同一版行程。 */
export function itineraryFingerprint(itinerary: unknown): string {
  return createHash("sha256").update(JSON.stringify(itinerary ?? null)).digest("hex").slice(0, 24);
}

/** 仅由 itinerary patch 调用：让旧 completion 明确失效，并等待运营采用。 */
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
    if (node.id === "poiResolution") {
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
    if (node.id === "itineraryDraft") {
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
    nodes: plan.nodes.map((node) => ITINERARY_NODES.has(node.id) || COMPLETION_NODES.has(node.id)
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

export type RequiredItinerarySpot = {
  dayIndex: number;
  spotIndex: number;
  name: string;
  travelNode: boolean;
};

/** 收集当前 itinerary 中必须拥有真实 POI 的可游览景点。 */
export function collectRequiredItinerarySpots(itinerary: unknown): RequiredItinerarySpot[] {
  const result: RequiredItinerarySpot[] = [];
  for (const [dayIndex, day] of (Array.isArray(itinerary) ? itinerary : []).entries()) {
    const record = asRecord(day);
    for (const [spotIndex, spot] of (Array.isArray(record?.spots) ? record.spots : []).entries()) {
      const value = asRecord(spot);
      const name = text(value?.name) || text(value?.poiName) || (typeof spot === "string" ? spot.trim() : "");
      if (!name) continue;
      result.push({ dayIndex, spotIndex, name, travelNode: isTravelNodeName(name) });
    }
  }
  return result;
}

export function isTravelNodeName(value: string): boolean {
  const name = value.trim();
  if (!name) return false;
  if (SETTLEMENT_NODE_NAMES.has(name)) return true;
  if (/(城区|市区|县城|镇区)$/.test(name)) return true;
  return /(机场|航站楼|火车站|高铁站|动车站|汽车站|客运站|码头|酒店|宾馆|民宿|客栈|住宿|入住|集合|接送|接机|送机|接站|送站)/.test(name);
}

export type ItineraryAdoptionGuard = { ok: true } | { ok: false; reason: "itinerary_changed" | "adoption_state_changed" };

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

export function applyPoiMatches(
  itinerary: unknown,
  matches: ReadonlyMap<string, { poiName: string; poiId: number }>,
): { itinerary: Array<Record<string, unknown>>; missing: RequiredItinerarySpot[] } {
  const next = structuredClone(Array.isArray(itinerary) ? itinerary : []) as Array<Record<string, unknown>>;
  const missing: RequiredItinerarySpot[] = [];
  for (const spot of collectRequiredItinerarySpots(next)) {
    if (spot.travelNode) continue;
    const day = asRecord(next[spot.dayIndex]);
    const spots = Array.isArray(day?.spots) ? day.spots as unknown[] : [];
    const current = asRecord(spots[spot.spotIndex]);
    const match = matches.get(spot.name);
    if (!match) {
      missing.push(spot);
      continue;
    }
    if (current) {
      current.poiName = match.poiName;
      current.poiId = match.poiId;
    } else {
      spots[spot.spotIndex] = { name: spot.name, poiName: match.poiName, poiId: match.poiId };
    }
    if (day) day.spots = spots;
  }
  return { itinerary: next, missing };
}

export function findUserRecommendedSpotNames(itinerary: unknown, userMessage: string): string[] {
  const message = normaliseMentionText(userMessage);
  if (!message) return [];
  const names = collectRequiredItinerarySpots(itinerary)
    .filter((spot) => !spot.travelNode)
    .map((spot) => spot.name)
    .filter((name) => {
      const full = normaliseMentionText(name);
      const base = normaliseMentionText(name.split(/[（(]/, 1)[0] ?? "");
      return Boolean((full.length >= 2 && message.includes(full)) || (base.length >= 2 && message.includes(base)));
    });
  return [...new Set(names)];
}

/** 用户点名的未命中景点保留；AI 自荐但未命中的景点从行程中移除。 */
export function applyUnmatchedPoiSourcePolicy(
  itinerary: unknown,
  matches: ReadonlyMap<string, { poiName: string; poiId: number }>,
  userRecommendedSpotNames: ReadonlySet<string>,
): { itinerary: Array<Record<string, unknown>>; missing: RequiredItinerarySpot[]; removed: RequiredItinerarySpot[] } {
  const hydrated = applyPoiMatches(itinerary, matches);
  const next = hydrated.itinerary;
  const removed: RequiredItinerarySpot[] = [];
  const retainedMissing: RequiredItinerarySpot[] = [];
  const missingByDay = new Map<number, RequiredItinerarySpot[]>();
  for (const spot of hydrated.missing) {
    const items = missingByDay.get(spot.dayIndex) ?? [];
    items.push(spot);
    missingByDay.set(spot.dayIndex, items);
  }
  for (const [dayIndex, spots] of missingByDay) {
    const day = asRecord(next[dayIndex]);
    const daySpots = Array.isArray(day?.spots) ? day.spots as unknown[] : [];
    for (const spot of [...spots].sort((a, b) => b.spotIndex - a.spotIndex)) {
      if (userRecommendedSpotNames.has(spot.name)) {
        const current = asRecord(daySpots[spot.spotIndex]);
        if (current) {
          current.poiName = null;
          current.poiId = null;
        } else daySpots[spot.spotIndex] = { name: spot.name, poiName: null, poiId: null };
        retainedMissing.unshift(spot);
      }
      else {
        daySpots.splice(spot.spotIndex, 1);
        removed.unshift(spot);
      }
    }
    if (day) day.spots = daySpots;
  }
  return { itinerary: next, missing: retainedMissing, removed };
}

export function itineraryHasRequiredPois(itinerary: unknown): boolean {
  const spots = collectRequiredItinerarySpots(itinerary).filter((spot) => !spot.travelNode);
  if (spots.length === 0) return false;
  const days = Array.isArray(itinerary) ? itinerary : [];
  return spots.every((spot) => {
    const day = asRecord(days[spot.dayIndex]);
    const value = asRecord(Array.isArray(day?.spots) ? day.spots[spot.spotIndex] : undefined);
    return Boolean(text(value?.poiName) && positiveInteger(value?.poiId));
  });
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function normaliseMentionText(value: string): string {
  return value.toLocaleLowerCase("zh-CN").replace(/[\s，。！？、；：,.!?;:'"“”‘’（）()【】\[\]·—_-]+/g, "");
}
