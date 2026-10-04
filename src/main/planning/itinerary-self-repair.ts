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
 * Explicitly named attractions stay in their original order until an operator
 * resolves or removes them.  A missing POI never selects an `or` sibling.
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
      if (!name || isExplicitNonPoi(spot) || !isExplicitTravelNode(day, spot)) return true;
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
      repaired.push(spot);
      index += 1;
    }
    day.spots = repaired;
  }

  const changed = JSON.stringify(value) !== JSON.stringify(itinerary);
  return { itinerary, changed, removedTravelNodes, selectedAlternatives };
}

function spotName(value: JsonObject): string {
  return text(value.name) || text(value.poiName);
}

function isExplicitNonPoi(value: JsonObject): boolean {
  return value.kind === "free" || value.kind === "other";
}

function isExplicitTravelNode(day: JsonObject, spot: JsonObject): boolean {
  const name = spotName(spot);
  if (/^(?:接站|送站|接机|送机|接团|送团|接送|接火车|送火车)/u.test(name)) return true;
  if (/(?:\(|（)(?:入住|住宿)(?:\)|）)|^(?:入住|住宿)/u.test(name)) return true;
  if (!/(?:机场|航站楼|火车站|高铁站|动车站|汽车站|客运站|码头)/u.test(name)) return false;
  return /(?:接站|送站|接机|送机|接火车|送火车|接送)/u.test(`${text(day.title)} ${text(day.description)}`);
}

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
