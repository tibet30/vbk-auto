import type { ProductDetail } from "../../../shared/contracts.js";
import type { ModuleOutcome, PlanningModule } from "../../../shared/contracts-planning.js";
import { itineraryInputContractError } from "../itinerary-input-contract.js";
import { itineraryStructureError } from "../itinerary-structure.js";
import { validateModuleValue } from "../schemas.js";
import { hasValidVbkRecommendationLength } from "../vbk-recommendation-length.js";

type JsonObject = Record<string, unknown>;
type Recommendation = { category: string; text: string };

export function hasCompletePresentationRecommendations(
  value: unknown,
): value is { recommendations: Recommendation[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const recommendations = (value as JsonObject).recommendations;
  if (!Array.isArray(recommendations) || recommendations.length !== 3) return false;
  const categories = new Set<string>();
  return recommendations.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const category = cleanText((item as JsonObject).category);
    const text = cleanText((item as JsonObject).text);
    if (!category || !text || categories.has(category)) return false;
    if (!hasValidVbkRecommendationLength(text)) return false;
    categories.add(category);
    return true;
  });
}

export function patchRequestsRecommendations(patch: JsonObject): boolean {
  const presentation = patch.presentation;
  return Boolean(presentation && typeof presentation === "object" && !Array.isArray(presentation)
    && Object.hasOwn(presentation, "recommendations"));
}

export function assertPersistedItinerary(product: ProductDetail): void {
  const itinerary = product.product.itinerary;
  const structureError = itineraryStructureError(product.product as JsonObject);
  if (structureError) throw new Error(`每日行程未处理：写入后回读结构无效（${structureError}）。`);
  const contract = itineraryInputContractError(product, itinerary);
  if (contract) throw new Error(`每日行程未处理：写入后回读未通过锁定行程校验（${contract}）。`);
}

/** Collapse fallback summaries after all persisted validation has succeeded. */
export function normaliseOutcomeSummaries(
  accepted: readonly ModuleOutcome[],
  rejected: readonly ModuleOutcome[],
): Pick<import("./types.js").ProductGenerationAppliedResult, "accepted" | "rejected" | "hasAccepted"> {
  const acceptedByModule = new Map<string, ModuleOutcome>();
  for (const outcome of accepted) {
    const previous = acceptedByModule.get(outcome.module);
    acceptedByModule.set(outcome.module, previous ? mergeAcceptedEvidence(previous, outcome) : outcome);
  }
  const rejectedByModule = new Map<string, ModuleOutcome>();
  for (const outcome of rejected) {
    if (!acceptedByModule.has(outcome.module)) rejectedByModule.set(outcome.module, outcome);
  }
  return {
    accepted: [...acceptedByModule.values()],
    rejected: [...rejectedByModule.values()],
    hasAccepted: acceptedByModule.size > 0,
  };
}

function mergeAcceptedEvidence(previous: ModuleOutcome, current: ModuleOutcome): ModuleOutcome {
  return {
    ...previous,
    ...current,
    status: "accepted",
    acceptedFields: union(previous.acceptedFields, current.acceptedFields),
    missingFields: union(previous.missingFields, current.missingFields),
    researchTasks: current.researchTasks ?? previous.researchTasks,
    value: current.value ?? previous.value,
  };
}

function union(left?: readonly string[], right?: readonly string[]): string[] | undefined {
  const values = [...(left ?? []), ...(right ?? [])];
  return values.length ? [...new Set(values)] : undefined;
}

/** Verify every claimed module against the product snapshot read after writes. */
export function verifyPersistedOutcomes(
  product: ProductDetail,
  accepted: readonly ModuleOutcome[],
  rejected: readonly ModuleOutcome[],
): { accepted: ModuleOutcome[]; rejected: ModuleOutcome[] } {
  const verified: ModuleOutcome[] = [];
  const failed = [...rejected];
  for (const outcome of accepted) {
    const value = persistedModuleValue(product.product as JsonObject, outcome.module);
    if (value === UNVERIFIABLE) {
      verified.push(outcome);
      continue;
    }
    const result = validateModuleValue(outcome.module, value);
    if (result.ok) {
      verified.push(outcome);
    } else {
      failed.push({
        module: outcome.module,
        status: "rejected",
        reason: `写入后回读未确认 ${outcome.module}：${result.reason}`,
        writePath: outcome.writePath,
      });
    }
  }
  return { accepted: verified, rejected: failed };
}

const UNVERIFIABLE = Symbol("unverifiable");

function persistedModuleValue(product: JsonObject, module: PlanningModule): unknown {
  if (module === "basicInfo") return pick(record(product.basicInfo), [
    "subtitle", "province", "destinationCity", "meetingCity", "operationNotes",
  ]);
  if (module === "skeleton") {
    const operations = record(product.operations);
    const value = pick(operations, [
      "hotelTier", "pickupCity", "transport", "reusePickupForDropoff", "mealsIncluded",
    ]);
    const vehicle = record(operations?.vehicleResource);
    if (vehicle && Object.hasOwn(vehicle, "requestedTotalCost")) {
      value.vehicleResource = { requestedTotalCost: vehicle.requestedTotalCost };
    }
    return value;
  }
  if (module === "itinerary" || module === "presentation" || module === "researchTasks") {
    return UNVERIFIABLE;
  }
  const commercial = record(product.commercial);
  if (module === "packageName") return commercial?.packageName;
  return commercial?.[module];
}

function record(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function pick(value: JsonObject | undefined, keys: readonly string[]): JsonObject {
  const result: JsonObject = {};
  for (const key of keys) if (value && Object.hasOwn(value, key)) result[key] = value[key];
  return result;
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
