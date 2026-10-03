import { isTravelNodeName } from "./itinerary-adoption.js";

type JsonObject = Record<string, unknown>;

export interface ItinerarySelfRepairResult {
  itinerary: JsonObject[];
  changed: boolean;
  removedTravelNodes: string[];
  selectedAlternatives: Array<{ day: number; kept: string[]; removed: string[] }>;
}

/**
 * Convert model-friendly itinerary notes into the stricter VBK POI shape.
 * Travel and lodging nodes belong in descriptions, not in tourDailyPois.
 * For an explicit `or` group, a verified original option is sufficient: drop
 * only the unavailable siblings instead of asking the operator to choose.
 */
export function selfRepairItineraryForVbk(value: unknown, nights?: number): ItinerarySelfRepairResult {
  const itinerary = Array.isArray(value)
    ? value.filter(isRecord).map((day) => structuredClone(day))
    : [];
  const removedTravelNodes: string[] = [];
  const selectedAlternatives: ItinerarySelfRepairResult["selectedAlternatives"] = [];

  for (const day of itinerary) {
    if (day === itinerary.at(-1) && Number.isInteger(nights) && Number(nights) < itinerary.length
      && /(?:不实际安排住宿|不安排住宿|无需住宿|无住宿)/u.test(text(day.hotelDescription))) {
      day.hotel = "无";
      day.hotelDescription = "当日返程，不安排住宿";
      delete day.hotelCandidates;
    }
    const original = Array.isArray(day.spots) ? day.spots.filter(isRecord) : [];
    const withoutTravel = original.filter((spot) => {
      const name = spotName(spot);
      if (!name || isExplicitNonPoi(spot) || !isTravelNodeName(name)) return true;
      removedTravelNodes.push(name);
      return false;
    });
    const repaired: JsonObject[] = [];
    for (let index = 0; index < withoutTravel.length;) {
      const spot = withoutTravel[index]!;
      if (isExplicitNonPoi(spot)) {
        // Non-POI activities are independent; an old relation:'or' must not
        // join an attraction alternative group or stall this repair loop.
        spot.relation = "and";
        repaired.push(spot);
        index += 1;
        continue;
      }
      if (spot.relation !== "or") {
        repaired.push(spot);
        index += 1;
        continue;
      }
      const time = spot.timeOfDay;
      const group: JsonObject[] = [];
      while (index < withoutTravel.length) {
        const candidate = withoutTravel[index]!;
        if (isExplicitNonPoi(candidate) || candidate.relation !== "or" || candidate.timeOfDay !== time) break;
        group.push(candidate);
        index += 1;
      }
      const verified = group.filter(hasVerifiedPoi);
      if (group.length > 1 && verified.length > 0 && verified.length < group.length) {
        const removed = group.filter((candidate) => !hasVerifiedPoi(candidate)).map(spotName).filter(Boolean);
        const kept = verified.map((candidate) => {
          candidate.relation = verified.length > 1 ? "or" : "and";
          return spotName(candidate);
        }).filter(Boolean);
        repaired.push(...verified);
        selectedAlternatives.push({ day: Number(day.day) || 0, kept, removed });
      } else {
        repaired.push(...group);
      }
    }
    day.spots = repaired;
  }

  const changed = JSON.stringify(value) !== JSON.stringify(itinerary);
  return { itinerary, changed, removedTravelNodes, selectedAlternatives };
}

function hasVerifiedPoi(value: JsonObject): boolean {
  return Boolean(text(value.poiName)) && Number.isInteger(value.poiId) && Number(value.poiId) > 0;
}

function spotName(value: JsonObject): string {
  return text(value.name) || text(value.poiName);
}

function isExplicitNonPoi(value: JsonObject): boolean {
  return value.kind === "free" || value.kind === "other";
}

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
