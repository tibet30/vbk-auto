import { tourTitleSpots } from "../../../../shared/private-tour-copy.js";
import type { VbkSessionRequestBrowser } from "../../../infrastructure/vbk-session-request.js";
import { enrichItineraryPoiMetadata } from "../itinerary-api/poi-metadata.js";
import type { ProductItineraryDay } from "../itinerary-api/itinerary-types.js";

/** 最多四个并发查询；同一 POI 只查询一次，不改变行程和 POI 匹配结果。 */
export async function privateTourTitleSpots(page: VbkSessionRequestBrowser, itinerary: ProductItineraryDay[]) {
  const spots = itinerary.flatMap(day => day.spots ?? [])
    .filter((spot, index, all) => Number(spot.poiId) > 0
      && all.findIndex(other => Number(other.poiId) === Number(spot.poiId)) === index);
  const resolved = new Array<(typeof spots)[number]>(spots.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, spots.length) }, async () => {
    while (cursor < spots.length) {
      const index = cursor++;
      const spot = spots[index]!;
      if (spot.ticketType?.key === 1 || spot.ticketType?.key === 2) resolved[index] = spot;
      else {
        const [day] = await enrichItineraryPoiMetadata(page, [{ ...itinerary[0]!, spots: [spot] }]);
        resolved[index] = day!.spots![0]!;
      }
    }
  }));
  return tourTitleSpots(resolved);
}
