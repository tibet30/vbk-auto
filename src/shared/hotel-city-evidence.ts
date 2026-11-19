/**
 * 住宿城市的行政证据：住宿字段只能写平台可写的行政短名，不能写景区/乡镇/山头名。
 *
 * 「住珠峰」「住冈仁波齐」这类原文写法会被解析成住宿地原名，直接写进 hotelCity
 * 后，VBK 住宿城市查询查不到，录入阶段才失败。这里用当天已核验景点（真实 poiId +
 * 平台行政归属）反查所属县市，作为可写城市的证据；拿不到证据时调用方必须保持
 * 原值或清空，不能凭空补一个城市。
 */

import { toPlatformShortLocationName } from "./location-short-name.js";

type Json = Record<string, any>;

/** 乡镇、村级与景区类后缀都不是平台可写行政城市。 */
const UNWRITABLE_CITY_SUFFIX = /(?:镇|村|乡|景区|风景区|片区|园区|街区|社区|古城|古镇)$/u;

const shortName = (value: unknown) => toPlatformShortLocationName(value);
const compact = (value: unknown) => typeof value === "string" ? value.replace(/\s+/gu, "") : "";

export interface SpotHotelCityEvidence {
  /** 该景点的所属县市短名，住宿字段应写这个值。 */
  city: string;
  /** 命中的景点名，用于运营可读的阻塞说明。 */
  spotName: string;
}

/**
 * 住宿地写成了当天某个已核验景点的名字时，返回该景点的所属县市。
 *
 * 只在景点有真实 poiId、省份一致、且住宿地名既不等于该景点的 city 也不等于
 * district 时成立：住宿地本来就是行政城市（日喀则、定日）时不产生证据，
 * 避免把「住日喀则」改成该市下辖的某个区。
 */
export function spotNamedHotelCity(product: Json, day: Json, candidates: unknown[]): SpotHotelCityEvidence | undefined {
  const province = shortName((product.basicInfo ?? {}).province);
  const names = candidates.map(compact).filter((name) => name.length >= 2);
  if (!names.length) return undefined;
  const spots: Json[] = Array.isArray(day?.spots) ? day.spots : [];
  for (const spot of spots) {
    if (!spot || !(Number(spot.poiId) > 0)) continue;
    const spotName = compact(spot.name);
    const district = shortName(spot.district);
    const parentCity = shortName(spot.city);
    const city = district || parentCity;
    if (!spotName || !city || UNWRITABLE_CITY_SUFFIX.test(city)) continue;
    if (province && shortName(spot.province) && shortName(spot.province) !== province) continue;
    // 住宿地已经是该景点所属的市或县（「住日喀则」+「日喀则博物馆」）时不是证据：
    // 把地级市改写成下辖区只会让平台城市查询更查不到。
    const named = names.some((name) => name !== city && name !== parentCity && name !== district
      && (spotName.startsWith(name) || name.startsWith(spotName)));
    if (named) return { city, spotName: String(spot.name).trim() };
  }
  return undefined;
}

/** 住宿城市本身是否带乡镇/景区后缀（可判定为不可写时返回原因）。 */
export function unwritableHotelCityReason(city: unknown): string | undefined {
  const value = shortName(city);
  if (!value || !UNWRITABLE_CITY_SUFFIX.test(value)) return undefined;
  return `「${value}」是乡镇或景区名，不是平台可写行政城市`;
}
