import { toPlatformShortLocationName } from "../../../shared/location-short-name.js";
const textValue = (value: unknown) => typeof value === "string" ? value.trim() : "";
const positiveInteger = (value: unknown) => { const number = Number(value); return Number.isInteger(number) && number > 0 ? number : undefined; };

export function firstHotelResource(payload: unknown, city = "") {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const resources = Array.isArray((payload as Record<string, unknown>).resources) ? (payload as Record<string, unknown>).resources as unknown[] : [];
  const hotels = resources.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const category = record.category && typeof record.category === "object" && !Array.isArray(record.category) ? record.category as Record<string, unknown> : {};
    const haystack = `${textValue(record.resourceName)} ${textValue(record.resourceDesc)} ${textValue(record.categoryName)} ${textValue(category.categoryName)}`;
    return /酒店|hotel/i.test(haystack) && positiveInteger(record.resourceId) && textValue(record.resourceName) ? [record] : [];
  });
  const cityName = toPlatformShortLocationName(city);
  const selected = hotels.find((record) => {
    const administrativeCity = toPlatformShortLocationName(textValue(record.destinationCityName));
    return !cityName || (administrativeCity ? administrativeCity === cityName
      : `${textValue(record.resourceName)} ${textValue(record.resourceDesc)}`.includes(cityName));
  });
  if (!selected) return undefined;
  const resourceId = positiveInteger(selected.resourceId); const resourceName = textValue(selected.resourceName);
  if (!resourceId || !resourceName) return undefined;
  return { source: "vbk" as const, resourceId, resourceName, supplierCode: textValue(selected.vendorResourceCode) || undefined, roomType: textValue(selected.vendorResourceName) || undefined };
}
