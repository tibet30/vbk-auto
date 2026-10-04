import type { AgentSnapshot, ProductDetail } from "../../shared/contracts.js";
import { createHash } from "node:crypto";
import { evaluatePreparationCompletion } from "../planning/preparation-completion.js";

export interface PreparationDirectedAction {
  node: "itineraryDraft" | "poiResolution" | "hotelResolution";
  name: "generate_product_module" | "resolve_itinerary_pois" | "resolve_itinerary_hotels";
  arguments: Record<string, unknown>;
  progressKey: string;
}

/**
 * Select only mechanical local preparation work. This intentionally leaves
 * foundation, commercial, cover, real user choices, and VBK writes to Agent.
 */
export function decidePreparationAction(
  product: ProductDetail,
  snapshot?: AgentSnapshot,
): PreparationDirectedAction | undefined {
  const evaluation = evaluatePreparationCompletion(product, snapshot);
  const action = actionForNode(evaluation.currentNode);
  if (!action) return undefined;
  return {
    ...action,
    progressKey: progressKey({
      node: action.node,
      locked: lockedItineraryContext(product.product),
      missing: evaluation.missing.filter(isItineraryRelevantGap).sort(),
      itinerary: itineraryProgress(product.product),
      research: product.researchTasks
        .filter((task) => task.state !== "confirmed" && task.state !== "resolved")
        .filter((task) => /POI|景点|酒店|住宿|suggestPoi|人工确认|手动录入/i.test(`${task.label} ${task.detail || ""}`))
        .map((task) => ({ label: task.label, type: task.type, state: task.state }))
        .sort((left, right) => `${left.type}:${left.label}`.localeCompare(`${right.type}:${right.label}`)),
    }),
  };
}

function actionForNode(node: string): Omit<PreparationDirectedAction, "progressKey"> | undefined {
  if (node === "itineraryDraft") {
    return { node, name: "generate_product_module", arguments: { stage: "itinerary" } };
  }
  if (node === "poiResolution") {
    return { node, name: "resolve_itinerary_pois", arguments: {} };
  }
  if (node === "hotelResolution") {
    return { node, name: "resolve_itinerary_hotels", arguments: {} };
  }
  return undefined;
}

function lockedItineraryContext(product: Record<string, unknown>): Record<string, unknown> {
  const basic = record(product.basicInfo);
  return {
    meetingCity: text(basic?.meetingCity),
    destinationCity: text(basic?.destinationCity),
    province: text(basic?.province),
    days: number(basic?.days),
    nights: number(basic?.nights),
  };
}

function itineraryProgress(product: Record<string, unknown>): unknown[] {
  return Array.isArray(product.itinerary) ? product.itinerary.map((day) => {
    const item = record(day);
    return {
      day: number(item?.day),
      title: text(item?.title),
      descriptionPresent: Boolean(text(item?.description)),
      mealsPresent: Boolean(text(item?.meals)),
      hotel: text(item?.hotel),
      hotelTier: text(record(product.operations)?.hotelTier),
      hotelCandidates: Array.isArray(item?.hotelCandidates) ? item!.hotelCandidates.map((candidate) => {
        const value = record(candidate);
        return {
          hotelId: number(value?.hotelId), hotelName: text(value?.hotelName), cityName: text(value?.cityName), anchorName: text(value?.anchorName),
          anchorCityId: number(value?.anchorCityId), diamond: number(value?.diamond),
          scoreValid: validNonNegativeNumber(value?.score), distanceKmValid: validNonNegativeNumber(value?.distanceKm),
        };
      }) : [],
      spots: Array.isArray(item?.spots) ? item!.spots.map((spot) => {
        const value = record(spot);
        return {
          name: text(value?.name), kind: text(value?.kind), poiName: text(value?.poiName), poiId: number(value?.poiId),
          relation: text(value?.relation), timeOfDay: text(value?.timeOfDay), city: text(value?.city),
        };
      }) : [],
    };
  }) : [];
}

function isItineraryRelevantGap(value: string): boolean {
  return /itinerary|每日行程|POI|景点|酒店候选|人工确认|手动录入|suggestPoi/i.test(value);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function validNonNegativeNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function progressKey(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
