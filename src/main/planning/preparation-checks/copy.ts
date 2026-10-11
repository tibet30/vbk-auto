import type { ProductDetail } from "../../../shared/contracts.js";
import type { PreparationGap } from "../../../shared/contracts-preparation.js";
import { excludedItineraryCopyConflicts } from "../itinerary-alternative-consistency.js";

export function itineraryCopyGaps(detail?: ProductDetail): PreparationGap[] {
  const conflicts = detail ? excludedItineraryCopyConflicts(detail) : [];
  return conflicts.length ? [{
    code: "presentation", label: "派生行程文案",
    detail: `当前活动行程已排除 ${conflicts.join("、")}，需重建推荐与产品特色后才能确认。`,
    stage: "completion", node: "presentation",
  }] : [];
}
