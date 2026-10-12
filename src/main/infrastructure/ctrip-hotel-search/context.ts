import { hotelLocalitySearchArgs } from "../ctrip-hotel-locality.js";
import { toPlatformShortLocationName } from "../../../shared/location-short-name.js";
import type { HotelStayRequirement } from "../../../shared/hotel-stay-requirement.js";
import type { HotelSearchContext as Context } from "../ctrip-hotel-search-types.js";
import { normalise, record, text, positive, coordinates } from "./helpers.js";

export function selectCtripHotelContext(rows: unknown[], args: { anchorName: string; preferredCity?: string; requirePreferredCity?: boolean; requirement?: HotelStayRequirement }): Context {
  args = hotelLocalitySearchArgs(rows, args);
  const anchor = normalise(args.anchorName);
  const city = normalise(toPlatformShortLocationName(args.preferredCity));
  const candidates = rows.flatMap((value) => {
    const row = record(value);
    const id = text(row?.id); const cityId = positive(row?.cityId); const coordinate = coordinates(row);
    if (!row || !id || !cityId || !coordinate) return [];
    const word = text(row.word);
    const name = word || text(row.displayName);
    if (!name) return [];
    const rowCity = text(row.cityName);
    const type = text(row.type);
    const sameCity = Boolean(city && normalise(toPlatformShortLocationName(rowCity)) === city);
    if (args.requirePreferredCity && city && !sameCity) return [];
    const locality = args.requirement?.anchorName.replace(/(?:市|县|镇|村)$/u, "");
    if (args.requirement?.maxDistanceKm !== undefined && locality && !name.includes(locality)) return [];
    // City suggestions often have no coordinates. Their municipal landmark
    // represents the city center; a scenic spot sharing the prefix does not.
    const cityAnchor = city && normalise(toPlatformShortLocationName(args.anchorName)) === city;
    const municipalAnchor = cityAnchor && /人民政府$/u.test(name)
      && normalise(toPlatformShortLocationName(name.replace(/(?:市|县)?人民政府$/u, ""))) === city;
    const score = (sameCity ? 100 : 0)
      + (municipalAnchor ? 60 : 0)
      + (normalise(word) === anchor ? 40 : normalise(name) === anchor ? 30 : normalise(name).includes(anchor) ? 20 : 0)
      + (/Markland|Zone/i.test(type) ? 10 : 0);
    return [{ id, cityId, cityName: rowCity, name, coordinate, score, ...(args.requirement ? { requirement: args.requirement } : {}) }];
  });
  const selected = candidates.sort((left, right) => right.score - left.score || left.name.localeCompare(right.name, "zh-CN"))[0];
  if (selected && !city && candidates.some(candidate => candidate.score === selected.score && candidate.cityId !== selected.cityId)) {
    throw new Error(`住宿地标「${args.anchorName}」在多个城市同名，需确认每日住宿城市后再查询。`);
  }
  if (!selected) {
    const local = rows.map(record).filter(row => row && (!city || normalise(toPlatformShortLocationName(text(row.cityName))) === city));
    const missingCoordinates = local.filter(row => !coordinates(row)).length;
    throw new Error(`携程未找到${city || "目标城市"}内可定位的酒店检索地标：${args.anchorName}；要求同城且含有效ID、城市ID、坐标的地标至少1个，实际返回${rows.length}条、同城${local.length}条、同城缺坐标${missingCoordinates}条、通过全部条件0条（0＜1）；酒店列表尚未完成核验`);
  }
  return selected;
}
