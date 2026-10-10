import type { PoiSuggestCandidate, PoiSuggestDetailResult } from "../../shared/contracts-types.js";
import { toPlatformShortLocationName } from "../../shared/location-short-name.js";
import { hasCompletePoi } from "../../shared/itinerary-activity-kind.js";
import { inferExplicitPoiDayCity } from "./poi-context.js";

export interface PoiAutoSelectionMatch {
  poiName: string;
  poiId: number;
  province?: string;
  city?: string;
  district?: string;
}

export interface PoiAutoSelectionResult {
  status: "available" | "suspended" | "uncertain";
  reason?: "no_candidate" | "location_mismatch" | "ambiguous";
  match?: PoiAutoSelectionMatch;
}

export interface PoiAutoDisambiguator {
  (args: {
    localProductId: string;
    desired: string;
    product: Record<string, unknown>;
    candidates: Array<{ id: string; text: string }>;
  }): Promise<{ pickedText: string | null; confidence: number }>;
}

/**
 * 规划阶段的唯一 POI 决策顺序：程序严格命中优先；否则只将携程排序前 12 条
 * 交给 AI。选定后先核验营业状态，最后才以大于 80% 的 AI 置信度决定是否写回。
 */
export async function resolvePlanningPoiAutoSelection(args: {
  localProductId: string;
  keyword: string;
  product: Record<string, unknown>;
  /** 当前产品的目的地约束；缺失时保守地仅保留既有候选选择规则。 */
  context?: { destinationCity?: string; province?: string };
  detail: PoiSuggestDetailResult;
  /** Prior human confirmation; still requires a current candidate, location and availability check. */
  confirmedPoiId?: number;
  checkAvailability(poiId: number): Promise<{ status: "available" | "suspended" }>;
  disambiguate?: PoiAutoDisambiguator;
}): Promise<PoiAutoSelectionResult> {
  const confirmed = args.confirmedPoiId ? args.detail.candidates.find(candidate => candidate.poiId === args.confirmedPoiId
    && isPlanningPoiCandidateInContext(candidate, args.context, args.product, args.keyword, args.detail.candidates)) : undefined;
  if (args.confirmedPoiId && !confirmed) return { status: "uncertain", reason: args.detail.candidates.length ? "location_mismatch" : "no_candidate" };
  const exact = confirmed ?? (args.detail.best
    ? args.detail.candidates.find((candidate): candidate is PoiSuggestCandidate & { poiName: string; poiId: number } =>
      isPlanningPoiCandidateInContext(candidate, args.context, args.product, args.keyword, args.detail.candidates) && candidate.poiId === args.detail.best!.poiId)
    : undefined);
  let candidate = exact;
  let confidence = 1;

  if (!candidate && args.disambiguate) {
    const choices = args.detail.candidates
      .filter((item): item is PoiSuggestCandidate & { poiName: string; poiId: number } =>
        isPlanningPoiCandidateInContext(item, args.context, args.product, args.keyword, args.detail.candidates))
      .slice(0, 12);
    if (choices.length === 0) {
      return {
        status: "uncertain",
        reason: args.detail.candidates.length > 0 ? "location_mismatch" : "no_candidate",
      };
    }
    const outcome = await args.disambiguate({
      localProductId: args.localProductId,
      desired: args.keyword,
      product: args.product,
      candidates: choices.map((item) => ({ id: String(item.index), text: candidateLabel(item) })),
    });
    candidate = choices.find((item) => candidateLabel(item) === outcome.pickedText);
    confidence = outcome.confidence;
  }

  if (!candidate || !isSelectableCandidate(candidate) || !candidateMatchesContext(candidate, args.context, args.product, args.keyword, args.detail.candidates)) {
    return {
      status: "uncertain",
      reason: args.detail.candidates.length > 0 ? "location_mismatch" : "no_candidate",
    };
  }
  const availability = await args.checkAvailability(candidate.poiId);
  if (availability.status === "suspended") return { status: "suspended" };
  if (!exact && confidence <= 0.8) return { status: "uncertain", reason: "ambiguous" };
  return {
    status: "available",
    match: {
      poiName: candidate.poiName.trim(),
      poiId: candidate.poiId,
      ...(candidate.province?.trim() ? { province: candidate.province.trim() } : {}),
      ...(candidate.city?.trim() ? { city: candidate.city.trim() } : {}),
      ...(candidate.district?.trim() ? { district: candidate.district.trim() } : {}),
    },
  };
}

function isSelectableCandidate(candidate: PoiSuggestCandidate): candidate is PoiSuggestCandidate & { poiName: string; poiId: number } {
  return candidate.selectable && Boolean(candidate.poiName?.trim() && candidate.poiId && candidate.poiId > 0);
}

export function isPlanningPoiCandidateInContext(
  candidate: PoiSuggestCandidate,
  context: { destinationCity?: string; province?: string } | undefined,
  product: Record<string, unknown>,
  keyword: string,
  candidates?: PoiSuggestCandidate[],
): candidate is PoiSuggestCandidate & { poiName: string; poiId: number } {
  return isSelectableCandidate(candidate) && candidateMatchesContext(candidate, context, product, keyword, candidates);
}

function candidateLabel(candidate: PoiSuggestCandidate & { poiName: string }): string {
  const location = [candidate.province, candidate.city, candidate.district]
    .filter((value): value is string => Boolean(value?.trim()))
    .join("/");
  return location ? `${candidate.poiName} · ${location}` : candidate.poiName;
}

/**
 * 省份必须匹配产品行政约束。跨城市 POI 只在该行程日明确提到候选城市或区县时
 * 才允许写入，避免城市锚点为潮州时误删用户明确安排的南澳、汕头行程。
 */
function candidateMatchesContext(
  candidate: PoiSuggestCandidate,
  context: { destinationCity?: string; province?: string } | undefined,
  product: Record<string, unknown>,
  keyword: string,
  candidates?: PoiSuggestCandidate[],
): boolean {
  const destinationCity = normaliseAdministrativeName(context?.destinationCity);
  const province = normaliseAdministrativeName(context?.province);
  const candidateCity = normaliseAdministrativeName(candidate.city);
  const candidateProvince = normaliseAdministrativeName(candidate.province);
  if (province && (!candidateProvince || candidateProvince !== province)) return false;
  if (destinationCity && !candidateCity) return false;
  const days = Array.isArray(product.itinerary)
    ? product.itinerary.filter(day => isRecord(day) && dayContainsKeyword(day, keyword)) : [];
  const dayCities = new Set(days.map(day => normaliseAdministrativeName(inferExplicitPoiDayCity(day))).filter(Boolean));
  if (dayCities.size === 1 && !dayCities.has(candidateCity)
    && !itineraryExplicitlyAllowsLocation(product, keyword, candidateCity, candidate.district, candidate.poiName)) return false;
  if (destinationCity && candidateCity !== destinationCity
    && !itineraryExplicitlyAllowsLocation(product, keyword, candidateCity, candidate.district, candidate.poiName)
    && !(province && explicitlyNamedUniquePoi(product, keyword, candidate, candidates, province))) return false;
  return true;
}

/** 原要求指定地点有同省唯一官方名候选时，地点名本身就是跨城行程证据。
 * 允许景区类别尾缀，以及当天明确写出的官方名前缀；不借用酒店/旧 POI，
 * 不接受同名多地点；省份与营业门仍由调用链核验。
 */
function explicitlyNamedUniquePoi(product: Record<string, unknown>, keyword: string,
  candidate: PoiSuggestCandidate, candidates: PoiSuggestCandidate[] | undefined, province: string): boolean {
  const desired = normaliseText(keyword);
  if (!desired || !candidates) return false;
  const basic = isRecord(product.basicInfo) ? product.basicInfo : {};
  if (!normaliseText(String(basic.userIdea ?? "")).includes(desired)) return false;
  if (!Array.isArray(product.itinerary)) return false;
  const days = product.itinerary.filter(day => isRecord(day) && dayContainsKeyword(day, keyword));
  const matchesName = (name: string) => {
    const core = normaliseText(name).replace(/[（）()]/gu, "")
      .replace(/(?:旅游景区|地质公园|风景名胜区|风景区|景区)$/u, "");
    return normaliseText(name) === desired || core === desired || (desired.length >= 4 && core.endsWith(desired)
      && days.some(day => normaliseText(dayRouteText(day)).includes(core)
        || hasVerifiedOriginalRouteNeighbour(day, basic, candidate, province)));
  };
  if (!days.length || !matchesName(candidate.poiName ?? "")) return false;
  const ids = new Set(candidates.filter(item => isSelectableCandidate(item)
    && matchesName(item.poiName ?? "")
    && normaliseAdministrativeName(item.province) === province).map(item => item.poiId));
  return ids.size === 1 && ids.has(candidate.poiId);
}

/** A different, verified original stop establishes the day's city, never a hotel or stale alias. */
function hasVerifiedOriginalRouteNeighbour(day: Record<string, unknown>, basic: Record<string, unknown>,
  candidate: PoiSuggestCandidate, province: string): boolean {
  const raw = normaliseText(String(basic.userIdea ?? ""));
  const city = normaliseAdministrativeName(candidate.city);
  return Boolean(city) && (Array.isArray(day.spots) ? day.spots : []).some(spot => isRecord(spot)
    && hasCompletePoi(spot) && spot.poiId !== candidate.poiId
    && normaliseText(String(spot.name ?? "")).length >= 4 && raw.includes(normaliseText(String(spot.name)))
    && normaliseAdministrativeName(spot.province) === province && normaliseAdministrativeName(spot.city) === city);
}

function itineraryExplicitlyAllowsLocation(
  product: Record<string, unknown>,
  keyword: string,
  candidateCity: string,
  candidateDistrict: unknown,
  candidatePoiName?: string | null,
): boolean {
  const itinerary = product.itinerary;
  if (!Array.isArray(itinerary)) return false;
  const locations = [
    ...locationNameVariants(candidateCity),
    ...locationNameVariants(candidateDistrict),
  ]
    .filter((location) => location.length >= 2);
  if (locations.length === 0) return false;
  return itinerary.some((day) => {
    if (!isRecord(day) || !dayContainsKeyword(day, keyword)) return false;
    const text = normaliseText(dayRouteText(day));
    // 羊卓雍湖是用户明确安排的山南景点；只认可同地点官方别名的山南候选。
    // 不把整个跨城行程日改成山南，也不放开西藏境内的任意同名候选。
    const lakeName = /^(?:羊卓雍湖|羊卓雍错)$/u;
    if (candidateCity === "山南" && lakeName.test(normaliseText(keyword))
      && lakeName.test(normaliseText(candidatePoiName ?? ""))) return true;
    return locations.some((location) => text.includes(normaliseText(location)));
  });
}

function dayContainsKeyword(day: Record<string, unknown>, keyword: string): boolean {
  const desired = normaliseText(keyword);
  if (desired.length < 2) return false;
  const spots = Array.isArray(day.spots) ? day.spots : [];
  return spots.some((spot) => {
    if (!isRecord(spot)) return false;
    const name = normaliseText(String(spot.name ?? ""));
    return name.length >= 2 && (name.includes(desired) || desired.includes(name));
  });
}

function dayRouteText(day: Record<string, unknown>): string {
  const spots = Array.isArray(day.spots) ? day.spots : [];
  const activities = Array.isArray(day.activities) ? day.activities : [];
  return [day.title, day.description, ...spots.flatMap((spot) => {
    if (!isRecord(spot)) return [];
    return [spot.name, spot.description];
  }), ...activities.flatMap((activity) => {
    if (!isRecord(activity)) return [];
    return [activity.title, activity.detail];
  })]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normaliseText(value: string): string {
  return value.replace(/\s+/gu, "").trim();
}

function normaliseAdministrativeName(value: unknown): string {
  return toPlatformShortLocationName(value);
}

function locationNameVariants(value: unknown): string[] {
  const raw = typeof value === "string" ? normaliseText(value) : "";
  const short = normaliseText(normaliseAdministrativeName(value));
  return [...new Set([raw, short].filter(Boolean))];
}
