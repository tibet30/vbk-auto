import { toPlatformShortLocationName } from "../../shared/location-short-name.js";
import type { HotelStayRequirement } from "../../shared/hotel-stay-requirement.js";

type Args = { anchorName: string; preferredCity?: string; requirePreferredCity?: boolean; requirement?: HotelStayRequirement };

/** A unique official town government proves its hotel-platform parent city, without moving the stay. */
export function hotelLocalitySearchArgs(rows: unknown[], args: Args): Args {
  const locality = args.anchorName.replace(/(?:市|县|镇|村)$/u, "");
  if (!locality) return args;
  const municipal = rows.filter((value): value is Record<string, unknown> => Boolean(value && typeof value === "object"))
    .filter(row => typeof row.word === "string" && /人民政府$/u.test(row.word)
      && row.word.replace(/(?:市|县|镇|村)?人民政府$/u, "") === locality
      && Number(row.cityId) > 0 && typeof row.cityName === "string" && Number(row.gLat ?? row.gdLat) > 0);
  if (new Set(municipal.map(row => row.cityId)).size !== 1) return args;
  const government = municipal[0]!;
  const city = toPlatformShortLocationName(government.cityName);
  const preferred = toPlatformShortLocationName(args.preferredCity);
  // Only replace a locality misused as a city, never an explicit different city.
  if (preferred && preferred !== toPlatformShortLocationName(locality) && preferred !== city) return args;
  return { ...args, anchorName: String(government.word), preferredCity: city, requirePreferredCity: true,
    requirement: { anchorName: String(government.word), ...args.requirement, cityName: city,
      ...(city !== toPlatformShortLocationName(locality) ? { maxDistanceKm: args.requirement?.maxDistanceKm ?? 5 } : {}) } };
}

/** Explicit nightly alternatives can be searched in order; no neighbouring city is invented. */
export function nightlyHotelAlternatives(hotel: string): string[] {
  const match = hotel.match(/^(.+?)(?:区域)?(?:酒店|住宿|入住)/u);
  if (!match || !/或/u.test(match[1]!)) return [];
  return match[1]!.split(/或(?:者)?/u).map(name => name.replace(/区域$/u, "").trim()).filter(Boolean);
}
