import type { PlanningPoiCandidate } from "../../shared/contracts-planning.js";
import type {
  PlanningOtherActivity,
  PlanningUserActivityIntent,
  PlanningUserActivityKind,
  PlanningUserIntent,
} from "../../shared/contracts-planning-intent.js";

const ACTIVITY_KINDS = new Set<PlanningUserActivityKind>([
  "poi", "activity", "transport", "meal", "hotel", "free",
]);

export function parsePlanningUserIntent(
  rawIdea: string,
  value: Record<string, unknown>,
): PlanningUserIntent {
  const preferences = Array.isArray(value.preferences)
    ? value.preferences.map(text).filter(Boolean).slice(0, 20)
    : [];
  const rows = Array.isArray(value.activities) ? value.activities : [];
  const activities: PlanningUserActivityIntent[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    const parsedTitle = text(record.title);
    const parsedKind = text(record.kind) as PlanningUserActivityKind;
    const day = Number(record.day);
    if (!parsedTitle || !ACTIVITY_KINDS.has(parsedKind) || !Number.isInteger(day) || day < 0) continue;
    const { title, kind } = normaliseUserActivityKind(parsedTitle, parsedKind);
    const durationMinutes = positiveInteger(record.durationMinutes);
    activities.push({
      id: `user-${activities.length + 1}`,
      day,
      title,
      kind,
      ...(text(record.time) ? { time: text(record.time) } : {}),
      ...(text(record.detail) ? { detail: text(record.detail) } : {}),
      ...(durationMinutes ? { durationMinutes } : {}),
    });
  }
  return { rawIdea: rawIdea.trim(), preferences, activities };
}

export function userPoiCandidateSeeds(intent: PlanningUserIntent): PlanningPoiCandidate[] {
  return intent.activities
    .filter((activity) => activity.kind === "poi")
    .map((activity) => ({
      requestedName: activity.title,
      status: "proposed" as const,
      source: "user" as const,
      userActivityId: activity.id,
      ...(activity.day > 0 ? { preferredDay: activity.day } : {}),
    }));
}

/** 用户地点只有“确实未命中”时才能降级；地域错误、暂停营业等仍需阻断。 */
export function blockingUserPoiFailure(candidates: PlanningPoiCandidate[]): string | undefined {
  const blocked = candidates.find((candidate) => candidate.source === "user"
    && candidate.status === "rejected"
    // 用户明确指定到某一天的景点是硬约束。未匹配时不能静默降级为普通
    // 活动并让 AI 用其它景点填满当天，否则“第一天/第二天”的原始计划会
    // 被改写。未指定日期的泛化体验活动仍保留原有降级语义。
    && (Boolean(candidate.preferredDay) || candidate.reason !== "未命中可确认的真实 POI"));
  return blocked
    ? `用户指定地点「${blocked.requestedName}」不能作为本次行程活动：${blocked.reason || "POI 校验失败"}`
    : undefined;
}

export function otherActivitiesForDay(args: {
  intent: PlanningUserIntent;
  candidates: PlanningPoiCandidate[];
  day: number;
  /** 当天已选中的真实 POI 名称。与用户活动同义时，不再重复写入「其他」。 */
  matchedPoiNames?: string[];
}): PlanningOtherActivity[] {
  const candidateByActivity = new Map(
    args.candidates.filter((candidate) => candidate.userActivityId)
      .map((candidate) => [candidate.userActivityId!, candidate]),
  );
  return args.intent.activities.flatMap((activity) => {
    if (activity.day > 0 && activity.day !== args.day) return [];
    if (activity.day === 0) return [];
    if (args.matchedPoiNames?.some((poiName) => isSamePoiActivity(activity.title, poiName))) return [];
    const candidate = candidateByActivity.get(activity.id);
    if (activity.kind === "poi" && candidate?.status !== "rejected") return [];
    if (activity.kind === "poi" && candidate?.reason !== "未命中可确认的真实 POI") return [];
    return [{
      time: activity.time || "不限",
      title: activity.title,
      detail: activity.detail || `按用户要求安排${activity.title}；该活动未使用已验证 POI。`,
      type: "other" as const,
      ...(activity.durationMinutes ? { durationMinutes: activity.durationMinutes } : {}),
      source: "user" as const,
    }];
  });
}

/**
 * 把「游览翠湖公园」「参观 翠湖公园」等用户自然语言与 POI 名称按同一口径比较。
 * 这里只做等值去重，不做模糊匹配，避免把相近但不同的活动误删。
 */
function isSamePoiActivity(activityTitle: string, poiName: string): boolean {
  const canonical = (value: string) => value
    .replace(/^(?:游览|参观|打卡|前往|去|到)\s*/, "")
    .replace(/\s+/g, "")
    .trim();
  const activity = canonical(activityTitle);
  const poi = canonical(poiName);
  return Boolean(activity) && activity === poi;
}

export function validateUserIntentDays(intent: PlanningUserIntent, days: number): string | undefined {
  const invalid = intent.activities.find((activity) => activity.day > days);
  return invalid ? `用户指定了第 ${invalid.day} 天的「${invalid.title}」，但产品只有 ${days} 天` : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function positiveInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

/** 明确“游览/参观某景点”不能被模型误降级为普通活动。 */
function normaliseUserActivityKind(title: string, kind: PlanningUserActivityKind) {
  const poiTitle = title.replace(/^(?:游览|参观|打卡|前往)\s*/, "").trim();
  const experienceActivity = /体验|手作|制作|课程|休息|自由活动|用餐|入住|接送|乘车|集合|离开|返程/.test(title);
  if (kind === "poi") {
    return experienceActivity
      ? { title, kind: "activity" as const }
      : { title: poiTitle || title, kind };
  }
  if (kind !== "activity") return { title, kind };
  return poiTitle && poiTitle !== title && !experienceActivity
    ? { title: poiTitle, kind: "poi" as const }
    : { title, kind };
}
