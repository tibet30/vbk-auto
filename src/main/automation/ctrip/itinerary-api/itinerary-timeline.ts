import { effectiveItinerarySpotKind } from "../../../../shared/itinerary-activity-kind.js";
import { buildAttractionPois } from "./info-builders.js";
import type { ProductItineraryDay, ReadbackDayExpectation } from "./itinerary-types.js";

type TimedSpot = { spot: NonNullable<ProductItineraryDay["spots"]>[number]; kind: "attraction" | "free" | "other"; timeOfDay: "morning" | "afternoon" };

export function effectiveTimedSpots(spots: NonNullable<ProductItineraryDay["spots"]>): TimedSpot[] {
  return spots.map((spot, index) => ({ spot, kind: effectiveItinerarySpotKind(spot), timeOfDay: spot.timeOfDay ?? (index < Math.ceil(spots.length / 2) ? "morning" : "afternoon") }));
}

export function dayOtherActivities(day: ProductItineraryDay) {
  const spotActivities = effectiveTimedSpots(day.spots ?? []).flatMap(({ spot, kind, timeOfDay }) => {
    if (kind === "attraction") return [];
    const time = timeOfDay === "morning" ? "上午" : "下午";
    return [{ time, title: spot.name, detail: spot.description?.trim() || spot.name, type: kind, durationMinutes: undefined, source: "user" as const }];
  });
  const legacyActivities = (day.activities ?? []).filter((activity) =>
    (activity.type === "other" || activity.type === "free")
      && typeof activity.time === "string" && Boolean(activity.time.trim())
      && typeof activity.title === "string" && Boolean(activity.title.trim())
      && typeof activity.detail === "string" && Boolean(activity.detail.trim()));
  // A migrated product can carry the same activity in the old list and unified spots.
  return [...spotActivities, ...legacyActivities.filter((activity) => !spotActivities.some((spot) =>
    spot.title === activity.title && spot.type === activity.type))];
}

export function buildAttractionInfo(spots: NonNullable<ProductItineraryDay["spots"]>, timeOfDay: "morning" | "afternoon", sort: number): Record<string, unknown> {
  const realAttractions = spots.filter((spot) => effectiveItinerarySpotKind(spot) === "attraction");
  const description = spots.map((spot) => spot.description?.trim()).filter(Boolean).join("；");
  return {
    tourDailyInfoId: null, takeoffTime: { key: null, name: timeOfDay === "morning" ? "上午" : "下午" }, takeoffEndTime: { name: "" },
    activeType: { key: 3, name: "景点" }, sessionTimeType: 0, distance: 0, driveTime: 0, takeTime: 240, takeTimeType: 0,
    description, productsOnSale: "", specialGift: "", warmTips: "", sort, costInclude: false,
    tourDailyHotels: [], tourDailyTrains: [], tourDailyFlights: [], tourDailyPois: buildAttractionPois(realAttractions.length ? realAttractions : spots), tourDailyThemes: [],
    tourDailyPackageGatherList: [], tourDailyPackageDismissList: [], tourDailyDistricts: [], tourDailyPackageFlights: [],
    tourDailyPackageTrains: [], tourDailyPackageIntermodals: [], tourDailyPackageShips: [], tourDailyPackageHotels: [],
    startOnBoardTime: "", stopOnBoardTime: "", communication: "", customStatus: 0, arriveTime: "", departTime: "",
    directionWay: { key: "", name: "" }, recommendActivities: [], pkgProductId: 0, pkgTourInfoId: 0, pkgDayDesc: "", pkgShoppingId: "", versionNum: 0,
  };
}

export function dayTimeline(day: ProductItineraryDay): ReadbackDayExpectation["timeline"] {
  const source = effectiveTimedSpots(day.spots ?? []);
  // Legacy products did not persist a unified activity timeline.  Their old
  // fixture/card can be checked by checkActivities, but must not become an
  // unexpected ordering contract during migration.
  if (!(day.spots ?? []).some((spot) => spot.kind === "attraction" || spot.kind === "free" || spot.kind === "other")) return [];
  const entries: ReadbackDayExpectation["timeline"] = [];
  for (let i = 0; i < source.length;) {
    const entry = source[i]; const { spot, kind } = entry;
    if (kind !== "attraction") {
      const time = entry.timeOfDay === "morning" ? "上午" : "下午";
      entries.push({ kind, description: `${time} ${spot.name}：${spot.description?.trim() || spot.name}`, time });
      i += 1; continue;
    }
    const time = entry.timeOfDay;
    const run = [spot]; i += 1;
    while (i < source.length && source[i].kind === "attraction" && source[i].timeOfDay === time) run.push(source[i++].spot);
    entries.push({ kind: "attraction", pois: run.map((item) => ({ poiId: typeof item.poiId === "number" ? item.poiId : 0, poiName: item.poiName || item.name })) });
  }
  for (const activity of dayOtherActivities(day).filter((activity) => !source.some((entry) => entry.spot.name === activity.title && entry.kind === activity.type))) {
    entries.push({ kind: activity.type === "free" ? "free" : "other", description: otherDescriptionForActivity(activity), time: activity.time, durationMinutes: activity.durationMinutes });
  }
  return entries;
}

export function otherDescriptionForActivity(activity: NonNullable<ProductItineraryDay["activities"]>[number]): string {
  const prefix = activity.time && activity.time !== "不限" ? `${activity.time} ` : "";
  return `${prefix}${activity.title}：${activity.detail}`;
}

