import type { PoiSuggestCandidate, PoiSuggestDetailResult } from "../../shared/contracts-types.js";
import { chooseUsablePoiOptions, type PoiUsabilityDecision } from "../planning/poi-usable-choices.js";

export type CompactPoiCandidate = {
  poiName: string | null;
  poiId: number | null;
  selectable: boolean;
  usable: boolean;
  availabilityStatus: "available" | "suspended" | "unavailable" | "unchecked";
  availabilityReason?: string;
  province?: string | null;
  city?: string | null;
  district?: string | null;
};

/** 给模型看的精简 POI 结果：避免完整候选列表撑爆 24KB 截断。 */
export function compactPoiQueryResult(args: {
  keyword: string;
  detail: PoiSuggestDetailResult;
  availability: Map<number, { status: "available" | "suspended" }>;
  maxCandidates?: number;
}): {
  keyword: string;
  httpStatus: number;
  businessStatus: PoiSuggestDetailResult["businessStatus"];
  poiListCount: number;
  best: PoiSuggestDetailResult["best"];
  candidates: CompactPoiCandidate[];
  usableDecision: PoiUsabilityDecision;
} {
  const maxCandidates = Math.max(1, Math.min(20, args.maxCandidates ?? 20));
  const enriched = args.detail.candidates.map((item) => enrichCandidate(item, args.availability));
  const usable = enriched.filter((item) => item.usable);
  const selected = (usable.length ? usable : enriched.filter((item) => item.selectable)).slice(0, maxCandidates);
  const decision = chooseUsablePoiOptions(enriched
    .filter((item) => item.poiName)
    .map((item) => ({
      name: item.poiName!,
      usable: item.usable,
      reason: item.availabilityReason,
      ...(item.poiId ? { poiId: item.poiId } : {}),
    })));
  return {
    keyword: args.keyword,
    httpStatus: args.detail.httpStatus,
    businessStatus: args.detail.businessStatus,
    poiListCount: args.detail.poiListCount,
    best: args.detail.best,
    candidates: selected,
    usableDecision: decision,
  };
}

export function poiCandidatesForAvailability(args: {
  keyword: string;
  detail: PoiSuggestDetailResult;
  maxCandidates?: number;
}): PoiSuggestCandidate[] {
  const maxCandidates = Math.max(1, Math.min(20, args.maxCandidates ?? 5));
  const selectable = args.detail.candidates.filter((item) => item.selectable && item.poiId);
  const bestId = args.detail.best?.poiId;
  if (bestId) {
    const bestCandidate = selectable.find((item) => item.poiId === bestId);
    return bestCandidate ? [bestCandidate] : [];
  }
  const keyword = normalisePoiName(args.keyword);
  if (!keyword || keyword.length < 2) return [];
  return selectable
    .filter((item) => isStrongPoiNameMatch(keyword, normalisePoiName(item.poiName)))
    .slice(0, maxCandidates);
}

function enrichCandidate(
  item: PoiSuggestCandidate,
  availability: Map<number, { status: "available" | "suspended" }>,
): CompactPoiCandidate {
  if (!item.selectable || !item.poiId) {
    return {
      poiName: item.poiName,
      poiId: item.poiId,
      selectable: item.selectable,
      usable: false,
      availabilityStatus: "unavailable",
      availabilityReason: "未查到可绑定 POI",
      province: item.province,
      city: item.city,
      district: item.district,
    };
  }
  const availabilityStatus = availability.get(item.poiId)?.status;
  if (!availabilityStatus) {
    return {
      poiName: item.poiName,
      poiId: item.poiId,
      selectable: item.selectable,
      usable: false,
      availabilityStatus: "unchecked",
      availabilityReason: "尚未确认是目标景点，未查营业状态",
      province: item.province,
      city: item.city,
      district: item.district,
    };
  }
  const status = availabilityStatus;
  const usable = status === "available";
  return {
    poiName: item.poiName,
    poiId: item.poiId,
    selectable: item.selectable,
    usable,
    availabilityStatus: status,
    ...(usable ? {} : { availabilityReason: "暂停营业" }),
    province: item.province,
    city: item.city,
    district: item.district,
  };
}

function normalisePoiName(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .replace(/[【】\[\]（）()《》〈〉""'']/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function isStrongPoiNameMatch(keyword: string, candidate: string): boolean {
  if (!keyword || !candidate) return false;
  return candidate === keyword || candidate.includes(keyword) || keyword.includes(candidate);
}
