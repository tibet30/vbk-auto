import type { ProductDetail } from "../../../shared/contracts.js";
import type { PreparationGap } from "../../../shared/contracts-preparation.js";
import { excludedItineraryCopyConflicts } from "../itinerary-alternative-consistency.js";
import { hasCompletePresentationRecommendations } from "../product-generation/validation.js";
import { presentationRecommendationTexts, recommendationQualityProblems } from "../validation/recommendation-quality.js";

export function itineraryCopyGaps(detail?: ProductDetail): PreparationGap[] {
  const conflicts = detail ? excludedItineraryCopyConflicts(detail) : [];
  return conflicts.length ? [{
    code: "presentation", label: "派生行程文案",
    detail: `当前活动行程已排除 ${conflicts.join("、")}，需重建推荐与产品特色后才能确认。`,
    stage: "completion", node: "presentation",
  }] : [];
}

/** 已保存的 3 条推荐理由结构合格但不具体时列为缺口，与生成与写入门禁一致。 */
export function recommendationQualityGaps(product: Record<string, unknown>): PreparationGap[] {
  if (!hasCompletePresentationRecommendations(product.presentation)) return [];
  const problems = recommendationQualityProblems(product, presentationRecommendationTexts(product.presentation) ?? []);
  return problems.length ? [{
    code: "presentation", label: "推荐理由具体性",
    detail: `推荐理由不够具体：${problems.join("；")}，需重新生成。`,
    stage: "completion", node: "presentation",
  }] : [];
}
