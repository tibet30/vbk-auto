/** 候选存在但未能选定：区分「目录没有同形地点」与「同名但地域不符」。 */
import type { PoiSuggestCandidate } from "../../shared/contracts-types.js";
import type { PoiSelectionReason } from "../../shared/poi-research-outcome.js";
import { isCompatiblePoiIdentity } from "../../shared/poi-candidate-identity.js";
import { plausiblyEquivalentPoiName } from "../../shared/poi-name-equivalence.js";

export function uncertainReason(keyword: string, candidates: PoiSuggestCandidate[] | undefined): PoiSelectionReason {
  if (!candidates?.length) return "no_candidate";
  const named = candidates.some(candidate => isSelectableCandidate(candidate)
    && plausiblyEquivalentPoiName(keyword, candidate.poiName)
    && isCompatiblePoiIdentity(keyword, candidate.poiName));
  return named ? "location_mismatch" : "identity_mismatch";
}

export function isSelectableCandidate(candidate: PoiSuggestCandidate): candidate is PoiSuggestCandidate & { poiName: string; poiId: number } {
  return candidate.selectable && Boolean(candidate.poiName?.trim() && candidate.poiId && candidate.poiId > 0);
}
