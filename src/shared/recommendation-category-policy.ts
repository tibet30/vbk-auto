import type { ProductForm } from "./product-form.js";

export interface RecommendationCategoryPolicy {
  source: "vbk-qconfig" | "fixed-replay";
  inputLocale: string;
  productPatternId: number;
  limited: boolean;
  categoryIds: number[];
  categories: string[];
  fetchedAt: string;
}

export interface RecommendationCategoryDirectoryItem {
  id: number;
  name: string;
}

export const PRODUCT_FORM_PATTERN_IDS: Record<ProductForm, number> = {
  groupTour: 1,
  freeTravel: 2,
  semiSelfGuided: 3,
  privateTour: 4,
};

export function presentationRecommendationCategories(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const recommendations = (value as Record<string, unknown>).recommendations;
  if (!Array.isArray(recommendations)) return [];
  return recommendations.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return "";
    return String((item as Record<string, unknown>).category ?? "").trim();
  });
}

export function unavailableRecommendationCategories(
  presentation: unknown,
  policy: Pick<RecommendationCategoryPolicy, "categories">,
): string[] {
  const allowed = new Set(policy.categories);
  return [...new Set(presentationRecommendationCategories(presentation).filter((name) => name && !allowed.has(name)))];
}
