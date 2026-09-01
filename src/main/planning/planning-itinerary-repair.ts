import type {
  PlanningItineraryDayDraft,
  PlanningPoiCandidate,
} from "../../shared/contracts-planning.js";
import type { PlanningUserIntent } from "../../shared/contracts-planning-intent.js";
import { otherActivitiesForDay } from "./user-intent.js";

type VerifiedCandidate = PlanningPoiCandidate & { poiId: number; poiName: string };

function verified(pool: PlanningPoiCandidate[]): VerifiedCandidate[] {
  const byId = new Map<number, VerifiedCandidate>();
  for (const candidate of pool) {
    if (candidate.status === "resolved" && candidate.poiId && candidate.poiName && !byId.has(candidate.poiId)) {
      byId.set(candidate.poiId, candidate as VerifiedCandidate);
    }
  }
  return [...byId.values()];
}

function cityOf(candidate: PlanningPoiCandidate | undefined): string {
  return typeof candidate?.city === "string" ? candidate.city.trim() : "";
}

function dayCity(
  draft: PlanningItineraryDayDraft | undefined,
  byId: Map<number, VerifiedCandidate>,
): string {
  if (!draft) return "";
  for (const poiId of draft.poiIds) {
    const city = cityOf(byId.get(poiId));
    if (city) return city;
  }
  return "";
}

function copyFor(names: string[]) {
  const joined = names.join("、");
  return {
    title: `${names.join("·")}游览`,
    description: `游览${joined}，结合实际开放时间安排当日节奏。`,
  };
}

/**
 * 修复模型偶发遗漏的空白日：只能使用候选池中已核验、未被其它日期占用的 POI。
 * 用户指定日期的 POI 优先且完整保留；普通补位优先选择与相邻日期同城的候选。
 * 没有安全候选时保持原样，继续交给 expandVerifiedItinerary 的严格门禁阻断。
 */
export function repairMissingItineraryDays(args: {
  drafts: PlanningItineraryDayDraft[];
  pool: PlanningPoiCandidate[];
  userIntent?: PlanningUserIntent;
}): PlanningItineraryDayDraft[] {
  const candidates = verified(args.pool);
  const byId = new Map(candidates.map((candidate) => [candidate.poiId, candidate]));
  const originalUseCounts = new Map<number, number>();
  for (const poiId of args.drafts.flatMap((draft) => draft.poiIds)) {
    originalUseCounts.set(poiId, (originalUseCounts.get(poiId) ?? 0) + 1);
  }
  // 原本只出现一次的 POI 是 AI 的有效编排结果，修复空白/重复日时不占用它。
  const reservedIds = new Set([...originalUseCounts]
    .filter(([, count]) => count === 1)
    .map(([poiId]) => poiId));
  const usedIds = new Set<number>();

  const fallbackFor = (index: number, excluded: Set<number>) => {
    const previousCity = dayCity(args.drafts[index - 1], byId);
    const nextCity = dayCity(args.drafts[index + 1], byId);
    return candidates
      .filter((candidate) => candidate.source !== "user"
        && !candidate.preferredDay
        && !reservedIds.has(candidate.poiId)
        && !usedIds.has(candidate.poiId)
        && !excluded.has(candidate.poiId))
      .map((candidate, order) => ({
        candidate,
        order,
        score: (previousCity && cityOf(candidate) === previousCity ? 2 : 0)
          + (nextCity && cityOf(candidate) === nextCity ? 2 : 0),
      }))
      .sort((left, right) => right.score - left.score || left.order - right.order)[0]?.candidate;
  };

  return args.drafts.map((draft, index) => {
    let poiIds = [...draft.poiIds];
    const hasOtherActivities = args.userIntent
      ? otherActivitiesForDay({
          intent: args.userIntent,
          candidates: args.pool,
          day: draft.day,
          matchedPoiNames: [],
        }).length > 0
      : false;
    if (poiIds.length === 0 && !hasOtherActivities) {
      const requiredUserIds = candidates
        .filter((candidate) => candidate.source === "user" && candidate.preferredDay === draft.day)
        .map((candidate) => candidate.poiId);
      if (requiredUserIds.length > 0) {
        poiIds = requiredUserIds;
      } else {
        const fallback = fallbackFor(index, new Set(poiIds));
        if (fallback) {
          poiIds = [fallback.poiId];
        }
      }
    }

    // 模型偶尔会把同一真实 POI 安排在两个日期。保留首次安排；后续普通
    // POI 只可替换为未使用、未被其它有效日期占用的已核验候选。用户强约束
    // 不改写，继续交给严格门禁提示人工处理。
    poiIds = poiIds.map((poiId) => {
      const candidate = byId.get(poiId);
      const locked = candidate?.source === "user" || Boolean(candidate?.preferredDay);
      const replacement = usedIds.has(poiId) && !locked
        ? fallbackFor(index, new Set(poiIds))
        : undefined;
      const nextId = replacement?.poiId ?? poiId;
      if (byId.has(nextId)) usedIds.add(nextId);
      return nextId;
    });

    if (poiIds.length === 0) return draft;
    const names = poiIds.map((poiId) => byId.get(poiId)?.poiName).filter((name): name is string => Boolean(name));
    if (names.length === 0) return { ...draft, poiIds };
    const fallbackCopy = copyFor(names);
    return {
      ...draft,
      poiIds,
      title: draft.title || fallbackCopy.title,
      description: draft.description || fallbackCopy.description,
    };
  });
}
