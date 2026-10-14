const GENERATED_REFERENCE_FIELDS = new Set([
  "tourDailyDescriptionId", "tourDailyInfoId", "tourDailyPackageGatherId", "tourDailyDinnerId",
  "tourDailyPoiId", "tourDailyHotelId", "tourDailyPackageHotelId", "tourDailyPackageDismissId",
  "parentId", "refId",
]);

const PLATFORM_EMPTY_FIELDS = new Set([
  "directionType", "fixedProductsOnSale", "pkgDepartureDate", "sightRecommend",
  "tourDailyCar", "tourDailyDinner", "tourDailyDismiss", "tourDailyGather", "transportation",
  "location", "poi", "rangeTemplateIds", "arriveDate", "arriveTime", "departureDate",
  "departureTime", "stationNo", "telCode", "costInclude", "groupType",
  "suggestPoiList", "themeSelectCount", "foodType", "basicRooms", "cruiseCompany",
  "hotelType", "ships",
]);

const TIME_FIELDS = new Set(["takeoffTime", "takeoffEndTime"]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isEmptyPlatformValue(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  const source = record(value);
  return source !== undefined && Object.values(source).every(isEmptyPlatformValue);
}

function poiIdentity(source: Record<string, unknown>): Record<string, unknown> {
  const ticket = record(source.relateSystemTicket);
  return {
    poiId: source.poiId,
    poiName: source.poiName,
    ...(ticket ? { relateSystemTicket: { key: ticket.key } } : {}),
  };
}

function hotelIdentity(source: Record<string, unknown>): Record<string, unknown> {
  return {
    hotelId: source.hotelId,
    hotelName: source.hotelName,
    hotelNameEn: source.hotelNameEn,
    grade: source.grade,
  };
}

/**
 * VBK's validation endpoint adds/removes reference IDs and empty UI scaffolding.
 * They carry no itinerary intent; non-empty or unknown fields remain protected.
 */
export function canonicalItineraryContent(value: unknown, parentKey = ""): unknown {
  if (Array.isArray(value)) return value.map(item => canonicalItineraryContent(item));
  const source = record(value);
  if (!source) return value;
  if (parentKey === "poi" && ("poiId" in source || "poiName" in source)) {
    return canonicalItineraryContent(poiIdentity(source));
  }
  if (parentKey === "hotel" && ("hotelId" in source || "hotelName" in source)) {
    return canonicalItineraryContent(hotelIdentity(source));
  }
  const activeType = record(source.activeType);
  return Object.fromEntries(Object.entries(source)
    .filter(([key, item]) => {
      if (GENERATED_REFERENCE_FIELDS.has(key)) return false;
      if (key === "useSegmentConfig" && Number(activeType?.key) !== 1) return false;
      if (PLATFORM_EMPTY_FIELDS.has(key) && isEmptyPlatformValue(item)) return false;
      if (TIME_FIELDS.has(parentKey) && key === "key" && isEmptyPlatformValue(item)) return false;
      return true;
    })
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonicalItineraryContent(item, key)]));
}
