import type { CtripHotelCandidate } from "../../../shared/contracts-types.js";
import { toPlatformShortLocationName } from "../../../shared/location-short-name.js";
import { HotelCandidatesUnavailableError } from "../ctrip-hotel-list-parser.js";
import { record, text, positive, normalise } from "./helpers.js";

/** Detail responses carry coordinates and ratings that Hotel suggestions omit. */
export function parseHotelDetail(html: string, expectedId: number, expectedCity: string) {
  const chunks = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].flatMap(match => {
    const source = match[1] ?? "";
    if (source.includes('id="__NEXT_DATA__"')) return [source];
    const flight = source.match(/self\.__next_f\.push\((\[[\s\S]*\])\)/);
    if (!flight) return [source];
    try { return (JSON.parse(flight[1]!) as unknown[]).filter((part): part is string => typeof part === "string"); }
    catch { return []; }
  });
  const data = chunks.join("");
  const base = objectField(data, "hotelBaseInfo");
  const position = objectField(data, "hotelPositionInfo");
  const star = record(base?.starInfo);
  const name = text(record(base?.nameInfo)?.name);
  const city = toPlatformShortLocationName(text(base?.cityName));
  if (positive(base?.masterHotelId) !== expectedId || city !== toPlatformShortLocationName(expectedCity)
    || Number(base?.countryId) !== 1 || !positive(base?.cityId) || !name) {
    throw new Error(`酒店详情身份核验失败：要求酒店ID=${expectedId}、城市=${expectedCity}、中国；实际ID=${base?.masterHotelId ?? "缺失"}、城市=${city || "缺失"}、国家ID=${base?.countryId ?? "缺失"}。`);
  }
  const lat = Number(position?.lat); const lng = Number(position?.lng);
  const diamond = Number(star?.level);
  const ratingType = star?.type;
  const comment = record(objectField(data, "hotelComment")?.comment);
  const score = Number(comment?.score);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !lat || !lng || Math.abs(lat) > 90 || Math.abs(lng) > 180
    || star?.level == null || star.level === "" || !Number.isInteger(diamond) || diamond < 0 || diamond > 5
    || !["diamond", "star", "homestay"].includes(String(ratingType)) || comment?.score == null || comment.score === "" || !Number.isFinite(score) || score < 0) {
    throw new Error(`酒店详情字段不完整：要求有效坐标、评级和评分；实际坐标=${position?.lat ?? "缺失"},${position?.lng ?? "缺失"}，评级=${star?.level ?? "缺失"}/${star?.type ?? "缺失"}，评分=${comment?.score ?? "缺失"}；未保存候选。`);
  }
  const candidate: CtripHotelCandidate = { hotelId: expectedId, hotelName: name, diamond, ratingType: ratingType as CtripHotelCandidate["ratingType"],
    score, cityName: city, address: text(position?.address), anchorName: name, anchorCityId: Number(base!.cityId),
    // For an explicitly named hotel the verified hotel itself is the anchor.
    // No distance is inferred between different coordinate systems.
    distanceKm: 0 };
  return { candidate, coordinate: { latitude: lat, longitude: lng } };
}

export async function fetchHotelDetail(id: number, city: string, fetcher: typeof fetch) {
  const response = await fetcher(`https://hotels.ctrip.com/hotels/${id}.html`, {
    headers: { "accept-language": "zh-CN,zh;q=0.9", "user-agent": "Mozilla/5.0" },
  });
  if (!response.ok) throw new Error(`酒店详情查询失败：酒店ID=${id}，HTTP ${response.status}；未取得可核验详情。`);
  return parseHotelDetail(await response.text(), id, city);
}

export function namedHotelSuggestion(rows: unknown[], hotelName: string, city: string): number {
  const target = normalise(hotelName).replace(/麗/gu, "丽").replace(new RegExp(`^${normalise(city)}`), "");
  const hotels = rows.map(record).filter(row => row?.type === "Hotel"
    && Number(row.countryId) === 1 && toPlatformShortLocationName(text(row.cityName)) === toPlatformShortLocationName(city)
    && normalise(text(row.word)).replace(/麗/gu, "丽").includes(target) && positive(row.id));
  const ids = [...new Set(hotels.map(row => Number(row!.id)))];
  if (ids.length !== 1) throw new HotelCandidatesUnavailableError(`指定酒店身份未确定：要求${city}「${hotelName}」唯一匹配；实际返回${rows.length}条建议，同城同名有效酒店${ids.length}家；${ids.length > 1 ? "存在多个分店，需要确认分店" : "未取得对应酒店身份"}，未保存候选。`);
  return ids[0]!;
}

export function matchNamedHotelTier(candidate: CtripHotelCandidate, target: number | undefined, allowDowngrade: boolean): CtripHotelCandidate[] {
  if (candidate.ratingType !== "diamond") throw new HotelCandidatesUnavailableError(`指定酒店评级类型不符：要求携程钻级；实际${candidate.hotelName}为${candidate.ratingType}，不能把星级或民宿评级当钻级。`);
  if (target === undefined) throw new Error("指定酒店缺少有效目标钻级，不能判定候选是否合格。");
  // The same, identity-verified hotel's rating cannot change between queries.
  // Walk the existing permitted grades without switching the user's hotel.
  const grades = allowDowngrade ? Array.from({ length: target + 1 }, (_, index) => target - index) : [target];
  if (!grades.includes(candidate.diamond)) throw new HotelCandidatesUnavailableError(`指定酒店钻级不符：要求${target}钻；实际${candidate.hotelName}（ID=${candidate.hotelId}）为${candidate.diamond}钻；差异=${candidate.diamond}≠${target}，${allowDowngrade ? "实际评级不在允许降档范围" : "当前禁止降档"}，未保存候选。`);
  return [candidate];
}

function objectField(source: string, key: string): Record<string, unknown> | null {
  const marker = `"${key}":`;
  let start = source.indexOf(marker);
  if (start < 0) return null;
  start = source.indexOf("{", start + marker.length);
  let depth = 0; let quoted = false; let escaped = false;
  for (let i = start; i >= 0 && i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) {
      try { return record(JSON.parse(source.slice(start, i + 1))); } catch { return null; }
    }
  }
  return null;
}
