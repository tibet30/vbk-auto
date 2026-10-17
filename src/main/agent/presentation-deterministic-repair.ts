import type { ProductDetail } from "../../shared/contracts.js";
import { unavailableRecommendationCategories } from "../../shared/recommendation-category-policy.js";
import { excludedItineraryCopyConflicts } from "../planning/itinerary-alternative-consistency.js";
import { presentationFallback } from "../planning/presentation-fallback.js";
import { hasCompletePresentationRecommendations } from "../planning/product-generation.js";

type JsonObject = Record<string, unknown>;

/** Rebuild stale derived copy from the active itinerary without asking the model to emit an already-present module. */
export function deterministicPresentationRepair(
  detail: ProductDetail,
  availableCategories: readonly string[],
): JsonObject | undefined {
  const product = detail.product as JsonObject;
  const current = record(product.presentation);
  if (!hasCompletePresentationRecommendations(current)) return undefined;
  const invalidCategories = unavailableRecommendationCategories(current, { categories: [...availableCategories] });
  const conflicts = excludedItineraryCopyConflicts(detail);
  if (!invalidCategories.length && !conflicts.length) return undefined;

  const fallback = presentationFallback(product, availableCategories);
  const currentCategory = text((current as JsonObject).recommendationCategory);
  const recommendationCategory = availableCategories.includes(currentCategory)
    ? currentCategory
    : fallback.recommendations[0]?.category;
  return { ...current, ...fallback, recommendationCategory };
}

function record(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
