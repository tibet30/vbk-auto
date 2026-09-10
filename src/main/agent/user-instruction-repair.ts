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
 * Apply explicit structural corrections before the Agent computes the new
 * intent fingerprint. This keeps a user correction authoritative without
 * weakening the normal lock that prevents the model from inventing a new
 * duration by itself.
 */
export function repairProductForExplicitInstruction(
  detail: ProductDetail,
  instruction: string,
): UserInstructionRepair | undefined {
  const durationRepair = repairProductForExplicitDuration(detail, instruction);
  const afterDuration = durationRepair
    ? { ...detail, product: durationRepair.product }
    : detail;
  const hotelRepair = repairProductForExplicitHotelCity(afterDuration, instruction);
  if (!durationRepair && !hotelRepair) return undefined;
  return {
    product: hotelRepair?.product ?? durationRepair!.product,
    reason: [durationRepair?.reason, hotelRepair?.reason].filter(Boolean).join(" "),
  };
}

export function repairProductForExplicitDuration(
  detail: ProductDetail,
  instruction: string,
): UserInstructionRepair | undefined {
  const requested = explicitDurationCorrection(instruction);
  if (!requested) return undefined;
  if (detail.productId || detail.basicInfoSaved || detail.automation?.status === "running") {
    return undefined;
  }

  const basic = asObject(detail.product.basicInfo);
  const currentDays = Number(basic?.days);
  const currentNights = Number(basic?.nights);
  if (requested.days === currentDays && requested.nights === currentNights) return undefined;

  const next = structuredClone(detail.product);
  const nextBasic = { ...(asObject(next.basicInfo) ?? {}) };
  nextBasic.days = requested.days;
  nextBasic.nights = requested.nights;
  for (const field of ["supplierProductName", "subtitle"] as const) {
    const value = text(nextBasic[field]);
    if (value) nextBasic[field] = replaceDuration(value, currentDays, currentNights, requested.days, requested.nights);
  }
  next.basicInfo = nextBasic;

  const commercial = asObject(next.commercial);
  if (commercial && text(commercial.packageName)) {
    next.commercial = {
      ...commercial,
      packageName: replaceDuration(text(commercial.packageName), currentDays, currentNights, requested.days, requested.nights),
    };
  }
  return {
    product: next,
    reason: `已按明确修正把产品调整为 ${requested.days} 天 ${requested.nights} 晚。`,
  };
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

function explicitDurationCorrection(instruction: string): { days: number; nights: number } | undefined {
  const compact = instruction.replace(/[\s“”"'`]/g, "");
  const number = "(?:[1-9][0-9]?|[一二三四五六七八九十]{1,3})";
  const correction = new RegExp(
    `(?:改成|改为|调整为|变更为|修改成|修改为|应为|应该是)(?:行程)?(${number})天(?:(${number})晚)?`,
    "g",
  );
  let requested: { days: number; nights: number } | undefined;
  for (const match of compact.matchAll(correction)) {
    const prefix = compact.slice(Math.max(0, (match.index ?? 0) - 5), match.index);
    if (/(?:不要|别|无需|取消)$/.test(prefix)) continue;
    const days = parseDurationNumber(match[1]);
    const explicitNights = parseDurationNumber(match[2]);
    const nights = explicitNights ?? (days === undefined ? undefined : Math.max(0, days - 1));
    if (days !== undefined && nights !== undefined && days >= 1 && days <= 60 && nights >= 0 && nights <= days) {
      requested = { days, nights };
    }
  }
  return requested;
}

function parseDurationNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value);
  const digits: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value === "十") return 10;
  const [tens, ones] = value.split("十");
  if (value.includes("十")) return (tens ? digits[tens] : 1) * 10 + (ones ? digits[ones] : 0);
  return digits[value];
}

function replaceDuration(value: string, oldDays: number, oldNights: number, days: number, nights: number): string {
  if (!Number.isInteger(oldDays) || !Number.isInteger(oldNights)) return value;
  return value.replace(`${oldDays}天${oldNights}晚`, `${days}天${nights}晚`);
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
