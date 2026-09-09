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
      isSelectableCandidateInContext(candidate, args.context) && candidate.poiId === args.detail.best!.poiId)
    : undefined;
  let candidate = exact;
  let confidence = 1;

  if (!candidate && args.disambiguate) {
    const choices = args.detail.candidates.slice(0, 12)
      .filter((item): item is PoiSuggestCandidate & { poiName: string; poiId: number } =>
        isSelectableCandidateInContext(item, args.context));
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

  if (!candidate || !isSelectableCandidate(candidate) || !candidateMatchesContext(candidate, args.context)) {
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

function isSelectableCandidateInContext(
  candidate: PoiSuggestCandidate,
  context: { destinationCity?: string; province?: string } | undefined,
): candidate is PoiSuggestCandidate & { poiName: string; poiId: number } {
  return isSelectableCandidate(candidate) && candidateMatchesContext(candidate, context);
}

function candidateLabel(candidate: PoiSuggestCandidate & { poiName: string }): string {
  const location = [candidate.province, candidate.city, candidate.district]
    .filter((value): value is string => Boolean(value?.trim()))
    .join("/");
  return location ? `${candidate.poiName} · ${location}` : candidate.poiName;
}

/**
 * 自动绑定只接受能被候选行政区字段明确证明属于目的地的 POI。
 * 不能因为名称相似、搜索排序靠前或 AI 高置信度而把外地同名点写入行程。
 */
function candidateMatchesContext(
  candidate: PoiSuggestCandidate,
  context: { destinationCity?: string; province?: string } | undefined,
): boolean {
  const destinationCity = normaliseAdministrativeName(context?.destinationCity);
  const province = normaliseAdministrativeName(context?.province);
  const candidateCity = normaliseAdministrativeName(candidate.city);
  const candidateProvince = normaliseAdministrativeName(candidate.province);
  if (destinationCity && candidateCity !== destinationCity) return false;
  if (province && candidateProvince && candidateProvince !== province) return false;
  return true;
}

function normaliseAdministrativeName(value: unknown): string {
  return typeof value === "string"
    ? value.trim().replace(/(维吾尔自治区|壮族自治区|回族自治区|自治区|特别行政区|省|市|地区|盟|州|自治州)$/u, "")
    : "";
}
