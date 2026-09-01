import type {
  PlanningItineraryDayDraft,
  PlanningPoiCandidate,
  PlanningPoiDisambiguationRequest,
  PlanningPoiDisambiguationResult,
} from "../../shared/contracts-planning.js";
import type { PlanningUserIntent } from "../../shared/contracts-planning-intent.js";
import type { PoiSuggestDetailResult } from "../../shared/contracts-types.js";
import { otherActivitiesForDay } from "./user-intent.js";
import { resolveAmbiguousPlanningPoi } from "./planning-poi-disambiguation.js";
import { repairMissingItineraryDays } from "./planning-itinerary-repair.js";

const FACILITY_RE = /入口|出口|停车场|售票处|游客中心|服务中心|换乘中心|检票口|接驳站|码头|车站|机场/;

const ADMINISTRATIVE_ALIASES: Record<string, string[]> = {
  北京: ["beijing", "peking"],
  天津: ["tianjin"],
  河北: ["hebei"],
  山西: ["shanxi"],
  内蒙古: ["inner mongolia", "neimenggu"],
  辽宁: ["liaoning"],
  吉林: ["jilin"],
  黑龙江: ["heilongjiang"],
  上海: ["shanghai"],
  江苏: ["jiangsu"],
  浙江: ["zhejiang"],
  安徽: ["anhui"],
  福建: ["fujian"],
  江西: ["jiangxi"],
  山东: ["shandong"],
  河南: ["henan"],
  湖北: ["hubei"],
  湖南: ["hunan"],
  广东: ["guangdong", "canton"],
  广西: ["guangxi"],
  海南: ["hainan"],
  重庆: ["chongqing"],
  四川: ["sichuan"],
  贵州: ["guizhou"],
  云南: ["yunnan"],
  西藏: ["tibet", "xizang"],
  陕西: ["shaanxi", "shensi"],
  甘肃: ["gansu"],
  青海: ["qinghai"],
  宁夏: ["ningxia"],
  新疆: ["xinjiang"],
  香港: ["hong kong"],
  澳门: ["macau", "macao"],
  拉萨: ["lhasa"],
  日喀则: ["shigatse", "xigaze", "rikaze"],
  江孜: ["gyantse"],
  林芝: ["nyingchi", "linzhi"],
  西安: ["xi'an", "xian"],
  成都: ["chengdu"],
  北京市: ["beijing"],
  上海市: ["shanghai"],
  重庆市: ["chongqing"],
  广州: ["guangzhou"],
  深圳: ["shenzhen"],
  昆明: ["kunming"],
  大理: ["dali"],
  丽江: ["lijiang"],
  乌鲁木齐: ["urumqi", "urumchi", "wulumuqi"],
  喀什: ["kashgar", "kashi"],
  杭州: ["hangzhou"],
  黄山: ["huangshan"],
  桂林: ["guilin"],
  三亚: ["sanya"],
  厦门: ["xiamen"],
  大同: ["datong"],
  太原: ["taiyuan"],
  兰州: ["lanzhou"],
  西宁: ["xining"],
  敦煌: ["dunhuang"],
  嘉峪关: ["jiayuguan"],
  张家界: ["zhangjiajie"],
};

export async function resolvePlanningPoiCandidates(args: {
  names: string[];
  province: string;
  city: string;
  concurrency?: number;
  beforeEach: () => Promise<void>;
  query: (name: string) => Promise<PoiSuggestDetailResult>;
  checkAvailability?: (poiId: number) => Promise<{ status: "available" | "suspended" }>;
  destination?: string;
  userIdea?: string;
  shouldDisambiguate?: (requestedName: string, index: number) => boolean;
  preferredDay?: (requestedName: string, index: number) => number | undefined;
  disambiguate?: (request: PlanningPoiDisambiguationRequest) => Promise<PlanningPoiDisambiguationResult>;
}): Promise<PlanningPoiCandidate[]> {
  const result = new Array<PlanningPoiCandidate>(args.names.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < args.names.length) {
      const index = cursor;
      cursor += 1;
      const requestedName = args.names[index];
      try {
        await args.beforeEach();
        const detail = await args.query(requestedName);
        const details = [detail];
        let candidate = toPlanningCandidate(requestedName, detail, args.province, args.city);
        const originallyAmbiguous = candidate.status === "rejected"
          && (candidate.reason === "未命中可确认的真实 POI" || candidate.reason?.startsWith("POI 地域不匹配"));
        // 通用名（如“长城”）首次查询可能优先返回异地 POI。不能因为首个
        // 搜索结果地域不匹配就中断一键链路；带产品城市重查一次，仍只接受
        // 通过同一地域校验的真实 POI，绝不猜测或复用异地 ID。
        const cityQualifiedName = `${args.city.trim()}${requestedName}`;
        if (originallyAmbiguous
          && args.city.trim()
          && !requestedName.startsWith(args.city.trim())) {
          await args.beforeEach();
          const cityDetail = await args.query(cityQualifiedName);
          details.push(cityDetail);
          candidate = toPlanningCandidate(requestedName, cityDetail, args.province, args.city);
        }
        if (args.disambiguate
          && originallyAmbiguous
          && args.shouldDisambiguate?.(requestedName, index)) {
          const resolved = await resolveAmbiguousPlanningPoi({
            requestedName,
            destination: args.destination || args.city,
            province: args.province,
            city: args.city,
            userIdea: args.userIdea,
            preferredDay: args.preferredDay?.(requestedName, index),
            details,
            disambiguate: args.disambiguate,
            validate: (source, best) => toPlanningCandidate(
              requestedName,
              { ...source, best },
              args.province,
              args.city,
            ),
          });
          if (resolved.candidate) candidate = resolved.candidate;
          else if (resolved.reason) candidate = { ...candidate, reason: resolved.reason };
        }
        if (candidate.status === "resolved" && candidate.poiId && args.checkAvailability) {
          const availability = await args.checkAvailability(candidate.poiId);
          result[index] = availability.status === "suspended"
            ? { requestedName, status: "rejected", poiId: candidate.poiId, poiName: candidate.poiName, reason: "携程景点详情标记为暂停营业" }
            : candidate;
        } else {
          result[index] = candidate;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/登录|Cookie|cookie|未登录/.test(message)) throw error;
        result[index] = { requestedName, status: "rejected", reason: `POI 查询失败：${message.slice(0, 160)}` };
      }
    }
  };
  const workerCount = Math.min(Math.max(1, args.concurrency ?? 5), args.names.length || 1);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return result;
}

export function toPlanningCandidate(
  requestedName: string,
  detail: PoiSuggestDetailResult,
  province: string,
  city: string,
): PlanningPoiCandidate {
  const best = detail.best;
  if (!best || !Number.isInteger(best.poiId) || best.poiId <= 0 || !best.poiName.trim()) {
    return { requestedName, status: "rejected", reason: "未命中可确认的真实 POI" };
  }
  if (FACILITY_RE.test(best.poiName)) {
    return { requestedName, status: "rejected", reason: "命中的是入口、停车场或服务设施" };
  }
  const raw = detail.candidates.find((candidate) => candidate.poiId === best.poiId);
  const fromTextFields = readLocationMetadata(raw?.textFields ?? []);
  // 优先用 suggestPoi 契约解析出的结构化字段（district + parents），textFields 仅兜底。
  const metadata = {
    province: raw?.province || fromTextFields.province,
    city: raw?.city || fromTextFields.city,
    district: raw?.district || fromTextFields.district,
    address: raw?.address || fromTextFields.address,
  };
  const hasKnownLocation = Boolean(metadata.province || metadata.city);
  const provinceMatches = locationMatches(metadata.province, province);
  const cityMatches = locationMatches(metadata.city, city);
  if (!hasKnownLocation || (!provinceMatches && !cityMatches)) {
    const actual = [metadata.province, metadata.city].filter(Boolean).join("/") || "地域未知";
    return { requestedName, status: "rejected", reason: `POI 地域不匹配（${actual}）` };
  }
  return {
    requestedName,
    status: "resolved",
    poiId: best.poiId,
    poiName: best.poiName.trim(),
    province: metadata.province || province,
    city: metadata.city || city,
    district: metadata.district,
    address: metadata.address,
  };
}

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
    }
    if (!draft.title || !draft.description || (draft.poiIds.length === 0 && otherActivities.length === 0)) {
      return { ok: false, reason: `第 ${index + 1} 天缺少标题、描述或有效活动节点` };
    }
    const spots: Array<Record<string, unknown>> = [];
    const cities = new Set<string>();
    for (const poiId of draft.poiIds) {
      const candidate = pool.get(poiId);
      if (!candidate) return { ok: false, reason: `第 ${index + 1} 天引用了候选池外的 POI ${poiId}` };
      if (candidate.source === "user" && candidate.preferredDay && candidate.preferredDay !== draft.day) {
        return { ok: false, reason: `用户指定的「${candidate.poiName}」必须保留在第 ${candidate.preferredDay} 天` };
      }
      if (selectedIds.has(poiId)) return { ok: false, reason: `POI ${candidate.poiName} 被重复使用` };
      selectedIds.add(poiId);
      if (candidate.city) cities.add(normaliseLocation(candidate.city));
      spots.push({ name: candidate.poiName, poiName: candidate.poiName, poiId });
    }
    if (cities.size > 1) return { ok: false, reason: `第 ${index + 1} 天跨越多个城市` };
    citySequence.push([...cities][0] ?? "");
    itinerary.push({
      day: index + 1,
      title: draft.title,
      description: draft.description,
      spots,
      // VBK 的行程 saveType=3 要求至少有一晚住宿节点；酒店名称本身
      // 仍由后续 hotelResource 阶段按 hotelTier 匹配真实资源。这里仅写
      // 一个明确的待匹配占位，避免把酒店资源误当成 AI 已确认的酒店。
      hotel: index < args.days - 1 ? "当地住宿（待匹配）" : "",
      meals: draft.meals || "早餐自理；午餐自理；晚餐自理",
      ...(draft.mealDescriptions ? { mealDescriptions: draft.mealDescriptions } : {}),
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

function readLocationMetadata(fields: Array<{ path: string; value: string }>) {
  const read = (patterns: RegExp[]) => fields.find((field) => patterns.some((pattern) => pattern.test(field.path)))?.value?.trim();
  const districtRecords = new Map<string, { name?: string; type?: string; path: string }>();
  for (const field of fields) {
    const match = field.path.match(/^(.*(?:^|\.)(?:district|districtInfo)(?:\.parents\[\d+\])?)\.(districtName|districtType)$/i);
    if (!match) continue;
    const record = districtRecords.get(match[1]) ?? { path: match[1] };
    if (match[2].toLowerCase() === "districtname") record.name = field.value.trim();
    else record.type = field.value.trim();
    districtRecords.set(match[1], record);
  }
  let province: string | undefined;
  let city: string | undefined;
  let district: string | undefined;
  for (const record of districtRecords.values()) {
    const kind = administrativeType(record.type);
    if (kind === "province" || kind === "municipality") province ??= record.name;
    if (kind === "city" || kind === "municipality") city ??= record.name;
    if (kind === "district") district ??= record.name;
    if (!district && record.name && !record.path.includes(".parents[")) district = record.name;
  }
  return {
    province: province ?? read([/(?:provinceName|province)(?:\.|$)/i]),
    city: city ?? read([/(?:cityName|city)(?:\.|$)/i]),
    district: district ?? read([/(?:districtName|district|countyName)(?:\.|$)/i]),
    address: read([/(?:address|addressDetail|displayAddress)(?:\.|$)/i]),
  };
}

function locationMatches(actual: string | undefined, expected: string): boolean {
  if (!actual || !expected) return false;
  const expectedKeys = locationKeys(expected);
  for (const key of locationKeys(actual)) {
    if (expectedKeys.has(key)) return true;
  }
  return false;
}

function normaliseLocation(value: string): string {
  return value.trim()
    .replace(/特别行政区|维吾尔自治区|壮族自治区|回族自治区|自治区|省|市|地区|自治州/g, "")
    .replace(/special administrative region|autonomous region|province|municipality|prefecture|city|district|county|league|state/gi, "")
    .replace(/[\s'’`·.-]/g, "")
    .toLowerCase();
}

function locationKeys(value: string): Set<string> {
  const normalised = normaliseLocation(value);
  const keys = new Set([normalised]);
  for (const [canonical, aliases] of Object.entries(ADMINISTRATIVE_ALIASES)) {
    const aliasKeys = [canonical, ...aliases].map(normaliseLocation);
    if (aliasKeys.includes(normalised)) keys.add(normaliseLocation(canonical));
  }
  return keys;
}

function administrativeType(value: string | undefined): "province" | "city" | "municipality" | "district" | undefined {
  const type = (value ?? "").trim().replace(/[\s'’`·.-]/g, "").toLowerCase();
  if (/province|autonomousregion|specialadministrativeregion|省|自治区|特别行政区/.test(type)) return "province";
  if (/municipality|直辖市/.test(type)) return "municipality";
  if (/city|prefecture|市|州|地区/.test(type)) return "city";
  if (/district|county|banner|旗|区|县/.test(type)) return "district";
  return undefined;
}

function hasBacktrack(cities: string[]): boolean {
  for (let i = 2; i < cities.length; i += 1) {
    if (cities[i] && cities[i] === cities[i - 2] && cities[i] !== cities[i - 1]) return true;
  }
  return false;
}
