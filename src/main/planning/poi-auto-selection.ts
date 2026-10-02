import type { PoiSuggestCandidate, PoiSuggestDetailResult } from "../../shared/contracts-types.js";

export interface PoiAutoSelectionMatch {
  poiName: string;
  poiId: number;
  province?: string;
  city?: string;
  district?: string;
}

export interface PoiAutoSelectionResult {
  status: "available" | "suspended" | "uncertain";
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
  checkAvailability(poiId: number): Promise<{ status: "available" | "suspended" }>;
  disambiguate?: PoiAutoDisambiguator;
}): Promise<PoiAutoSelectionResult> {
  const exact = args.detail.best
    ? args.detail.candidates.find((candidate): candidate is PoiSuggestCandidate & { poiName: string; poiId: number } =>
      isPlanningPoiCandidateInContext(candidate, args.context, args.product, args.keyword) && candidate.poiId === args.detail.best!.poiId)
    : undefined;
  let candidate = exact;
  let confidence = 1;

  if (!candidate && args.disambiguate) {
    const choices = args.detail.candidates.slice(0, 12)
      .filter((item): item is PoiSuggestCandidate & { poiName: string; poiId: number } =>
        isPlanningPoiCandidateInContext(item, args.context, args.product, args.keyword));
    if (choices.length === 0) return { status: "uncertain" };
    const outcome = await args.disambiguate({
      localProductId: args.localProductId,
      desired: args.keyword,
      product: args.product,
      candidates: choices.map((item) => ({ id: String(item.index), text: candidateLabel(item) })),
    });
    candidate = choices.find((item) => candidateLabel(item) === outcome.pickedText);
    confidence = outcome.confidence;
  }

  if (!candidate || !isSelectableCandidate(candidate) || !candidateMatchesContext(candidate, args.context, args.product, args.keyword)) {
    return { status: "uncertain" };
  }
  const availability = await args.checkAvailability(candidate.poiId);
  if (availability.status === "suspended") return { status: "suspended" };
  if (!exact && confidence <= 0.8) return { status: "uncertain" };
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
): candidate is PoiSuggestCandidate & { poiName: string; poiId: number } {
  return isSelectableCandidate(candidate) && candidateMatchesContext(candidate, context, product, keyword);
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
): boolean {
  const destinationCity = normaliseAdministrativeName(context?.destinationCity);
  const province = normaliseAdministrativeName(context?.province);
  const candidateCity = normaliseAdministrativeName(candidate.city);
  const candidateProvince = normaliseAdministrativeName(candidate.province);
  if (province && (!candidateProvince || candidateProvince !== province)) return false;
  if (destinationCity && !candidateCity) return false;
  if (destinationCity && candidateCity !== destinationCity
    && !itineraryExplicitlyAllowsLocation(product, keyword, candidateCity, candidate.district)) return false;
  return true;
}

function itineraryExplicitlyAllowsLocation(
  product: Record<string, unknown>,
  keyword: string,
  candidateCity: string,
  candidateDistrict: unknown,
): boolean {
  const itinerary = product.itinerary;
  if (!Array.isArray(itinerary)) return false;
  const locations = [candidateCity, normaliseAdministrativeName(candidateDistrict)]
    .filter((location) => location.length >= 2);
  if (locations.length === 0) return false;
  return itinerary.some((day) => {
    if (!isRecord(day) || !dayContainsKeyword(day, keyword)) return false;
    const text = normaliseText(dayRouteText(day));
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
  return [day.title, day.description, ...spots.flatMap((spot) => {
    if (!isRecord(spot)) return [];
    return [spot.name, spot.description];
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
  return typeof value === "string"
    ? value.trim().replace(/(维吾尔自治区|壮族自治区|回族自治区|自治区|特别行政区|自治州|地区|省|市|盟|州|县|区)$/u, "")
    : "";
}
