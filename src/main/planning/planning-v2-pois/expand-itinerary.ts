/**
 * expandVerifiedItinerary 主流程：
 *   - 调 repairMissingItineraryDays 补齐缺日 / 拼接用户备选；
 *   - 把 pool 按 poiId 入 Map；逐日核验 day 编号 + 候选引用 + 用户指定日 + 单日同城 + 不重复；
 *   - 把 draft 折成 VBK product 的 day → spots / hotel / meals / activities；
 *   - 末位兜底：用户指定 POI 必须入行程；跨日城市不能 A→B→A 折返。
 *
 * 设计要点：
 *   - 当日用户备选 POI 必须连续且与 preferredDay 一致；偏离任一项直接拒绝。
 *   - spots.timeOfDay = unitIndex < morningCount ? "morning" : "afternoon"；同 unit 内
 *     relation="or"，否则 "and"。
 *   - hotel 默认占位"当地住宿（待匹配）"由后续 hotelResolution 替换。
 */

import type { PlanningItineraryDayDraft, PlanningPoiCandidate } from "../../../shared/contracts-planning.js";
import type { PlanningUserIntent } from "../../../shared/contracts-planning-intent.js";
import { otherActivitiesForDay } from "../user-intent.js";
import { repairMissingItineraryDays } from "../planning-itinerary-repair.js";
import {
  buildDailyDescription,
  findSplitUserAlternativeGroup,
  hasBacktrack,
  itineraryDisplayUnits,
  mealDescriptionsForDay,
  mealSummaryForDay,
} from "./day-builder.js";

export function expandVerifiedItinerary(args: {
  drafts: PlanningItineraryDayDraft[];
  pool: PlanningPoiCandidate[];
  days: number;
  userIntent?: PlanningUserIntent;
}): { ok: true; itinerary: Array<Record<string, unknown>>; selectedIds: Set<number> } | { ok: false; reason: string } {
  const drafts = repairMissingItineraryDays({
    drafts: args.drafts,
    pool: args.pool,
    userIntent: args.userIntent,
  });
  const pool = new Map<number, PlanningPoiCandidate>();
  for (const candidate of args.pool) {
    if (candidate.status === "resolved" && candidate.poiId && candidate.poiName) pool.set(candidate.poiId, candidate);
  }
  if (drafts.length !== args.days) return { ok: false, reason: `行程必须恰好生成 ${args.days} 天` };
  const selectedIds = new Set<number>();
  const citySequence: string[] = [];
  const itinerary: Array<Record<string, unknown>> = [];
  for (let index = 0; index < args.days; index += 1) {
    const draft = drafts[index];
    if (draft.day !== index + 1) return { ok: false, reason: `第 ${index + 1} 天 day 编号不连续` };
    const matchedPoiNames = draft.poiIds
      .map((poiId) => pool.get(poiId)?.poiName)
      .filter((poiName): poiName is string => Boolean(poiName));
    const displayUnits = itineraryDisplayUnits(draft.poiIds, pool);
    const otherActivities = args.userIntent
      ? otherActivitiesForDay({
        intent: args.userIntent,
        candidates: args.pool,
        day: draft.day,
        matchedPoiNames,
      })
      : [];
    const requiredUserPoiIds = args.pool
      .filter((candidate) => candidate.source === "user"
        && candidate.status === "resolved"
        && candidate.preferredDay === draft.day
        && candidate.poiId)
      .map((candidate) => candidate.poiId!);
    if (requiredUserPoiIds.length > 0) {
      const unexpected = draft.poiIds.find((poiId) => !requiredUserPoiIds.includes(poiId));
      if (unexpected) {
        return { ok: false, reason: `第 ${draft.day} 天存在用户未指定的 POI ${unexpected}；请严格按用户逐日计划编排` };
      }
      const missing = requiredUserPoiIds.find((poiId) => !draft.poiIds.includes(poiId));
      if (missing) {
        return { ok: false, reason: `第 ${draft.day} 天遗漏用户指定的 POI ${missing}` };
      }
      const splitGroup = findSplitUserAlternativeGroup(draft.poiIds, pool);
      if (splitGroup) {
        return { ok: false, reason: `第 ${draft.day} 天用户备选 POI「${splitGroup}」必须连续放在同一段行程` };
      }
    }
    if (!draft.title || !draft.description || (draft.poiIds.length === 0 && otherActivities.length === 0)) {
      return { ok: false, reason: `第 ${index + 1} 天缺少标题、描述或有效活动节点` };
    }
    const spots: Array<Record<string, unknown>> = [];
    const morningCount = Math.ceil(displayUnits.length / 2);
    const unitByPoiId = new Map<number, number>();
    const relationByPoiId = new Map<number, "and" | "or">();
    displayUnits.forEach((unit, unitIndex) => unit.poiIds.forEach((poiId) => {
      unitByPoiId.set(poiId, unitIndex);
      relationByPoiId.set(poiId, unit.poiIds.length > 1 ? "or" : "and");
    }));
    const cities = new Set<string>();
    for (const poiId of draft.poiIds) {
      const candidate = pool.get(poiId);
      if (!candidate) return { ok: false, reason: `第 ${index + 1} 天引用了候选池外的 POI ${poiId}` };
      if (candidate.source === "user" && candidate.preferredDay && candidate.preferredDay !== draft.day) {
        return { ok: false, reason: `用户指定的「${candidate.poiName}」必须保留在第 ${candidate.preferredDay} 天` };
      }
      if (selectedIds.has(poiId)) return { ok: false, reason: `POI ${candidate.poiName} 被重复使用` };
      selectedIds.add(poiId);
      if (candidate.city) cities.add(normaliseCity(candidate.city));
      spots.push({
        name: candidate.poiName,
        poiName: candidate.poiName,
        poiId,
        ...(candidate.province ? { province: candidate.province } : {}),
        ...(candidate.city ? { city: candidate.city } : {}),
        ...(candidate.district ? { district: candidate.district } : {}),
        timeOfDay: (unitByPoiId.get(poiId) ?? spots.length) < morningCount ? "morning" : "afternoon",
        relation: relationByPoiId.get(poiId) ?? "and",
      });
    }
    if (cities.size > 1) return { ok: false, reason: `第 ${index + 1} 天跨越多个城市` };
    citySequence.push([...cities][0] ?? "");
    itinerary.push({
      day: index + 1,
      title: draft.title,
      description: buildDailyDescription({
        isFirst: index === 0,
        isLast: index === args.days - 1,
        morning: displayUnits.slice(0, morningCount).map((unit) => unit.label),
        afternoon: displayUnits.slice(morningCount).map((unit) => unit.label),
        hotel: index < args.days - 1 ? "当地住宿（待匹配）" : "",
      }),
      spots,
      // VBK 的行程 saveType=3 要求至少有一晚住宿节点。先写显式占位，
      // 后续 hotelResolution 会以当日末景点从携程替换为真实酒店与五个候选；
      // 行程取前三个，资源配置保留全部五个。
      hotel: index < args.days - 1 ? "当地住宿（待匹配）" : "",
      meals: mealSummaryForDay(index, args.days),
      mealDescriptions: mealDescriptionsForDay(index, args.days),
      ...(otherActivities.length ? { activities: otherActivities } : {}),
    });
  }
  const omittedUserPoi = args.pool.find((candidate) => candidate.source === "user"
    && candidate.status === "resolved"
    && candidate.poiId
    && !selectedIds.has(candidate.poiId));
  if (omittedUserPoi) return { ok: false, reason: `用户明确指定的 POI「${omittedUserPoi.poiName || omittedUserPoi.requestedName}」未进入最终行程` };
  if (hasBacktrack(citySequence)) return { ok: false, reason: "跨日路线形成 A→B→A 折返" };
  return { ok: true, itinerary, selectedIds };
}

function normaliseCity(value: string): string {
  return value.trim().replace(/特别行政区|维吾尔自治区|壮族自治区|回族自治区|自治区|省|市|地区|自治州/g, "");
}