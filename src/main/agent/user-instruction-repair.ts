import type { ProductDetail } from "../../shared/contracts.js";
import { hotelDiamondFromTier, normaliseHotelTier } from "../../shared/hotel-tiers.js";
import { hasItineraryHotelStay } from "../../shared/itinerary-hotel.js";
import { toPlatformShortLocationName } from "../../shared/location-short-name.js";

type JsonObject = Record<string, unknown>;

export interface UserInstructionRepair {
  product: JsonObject;
  reason: string;
}

/**
 * A final-confirmation card must not freeze a hotel result that contradicts a
 * later explicit lodging-city correction. Reopen only the derived hotel data;
 * the next Agent turn will see the hotel gap and run the normal resolver.
 */
export function repairProductForExplicitHotelCity(
  detail: ProductDetail,
  instruction: string,
): UserInstructionRepair | undefined {
  const product = detail.product;
  const basic = asObject(product.basicInfo);
  const destinationCity = toPlatformShortLocationName(text(basic?.destinationCity || basic?.meetingCity));
  if (!destinationCity || !explicitlyRequestsDestinationHotel(instruction, destinationCity)) return undefined;

  const itinerary = Array.isArray(product.itinerary) ? product.itinerary : [];
  let changed = false;
  const hotelTier = normaliseHotelTier(asObject(product.operations)?.hotelTier);
  const requiredDiamond = hotelDiamondFromTier(hotelTier);
  const hotelLabel = `${destinationCity}${hotelTier ? hotelTier.split("/")[0] : "酒店"}`;
  const nextItinerary = itinerary.map((value) => {
    const day = asObject(value);
    if (!day || !hasItineraryHotelStay(day.hotel)) return value;
    const candidates = Array.isArray(day.hotelCandidates) ? day.hotelCandidates : [];
    const wrongCity = candidates.some((candidate) => {
      const city = toPlatformShortLocationName(text(asObject(candidate)?.cityName));
      return city && city !== destinationCity;
    });
    const wrongDiamond = requiredDiamond !== undefined && candidates.some((candidate) => {
      return Number(asObject(candidate)?.diamond) !== requiredDiamond;
    });
    if (!wrongCity && !wrongDiamond && text(day.hotel).includes(destinationCity)) return value;
    changed = true;
    const next: JsonObject = { ...day, hotel: hotelLabel };
    delete next.hotelCandidates;
    return next;
  });
  if (!changed) return undefined;

  const next = structuredClone(product);
  next.itinerary = nextItinerary;
  const operations = { ...(asObject(next.operations) ?? {}) };
  delete operations.hotelResource;
  next.operations = operations;
  return {
    product: next,
    reason: `已按明确住宿约束清除旧酒店候选，将以${destinationCity}重新匹配。`,
  };
}

function explicitlyRequestsDestinationHotel(instruction: string, destinationCity: string): boolean {
  const compact = instruction.replace(/[\s“”"'`]/g, "");
  if (!compact.includes(destinationCity)) return false;
  return compact.includes(`住${destinationCity}`)
    || compact.includes(`入住${destinationCity}`)
    || new RegExp(`住宿(?:城市)?(?:锚点)?(?:=|为|按)?${escapeRegExp(destinationCity)}`).test(compact)
    || new RegExp(`${escapeRegExp(destinationCity)}(?:作为|为)?住宿(?:城市)?(?:锚点)?`).test(compact);
}

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
