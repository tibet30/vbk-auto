/**
 * vehicle-resource-api/administrative-parent-city：平台城市表没有的住宿落点
 * （乡镇「川主寺」、景区门户「九寨沟沟口」、景区「毕棚沟」）按 VBK 行政区父链
 * 取最近一级县市。
 *   - 只接受国内、锁定省份内唯一的同名节点；
 *   - 只上溯一级 City 父级，不借用州市或邻近城市；
 *   - 门户后缀（沟口、景区、古镇……）先还原为主体地名再查。
 */

import { vbkSessionRequest } from "../../../infrastructure/vbk-session-request.js";
import { assertVbkAckSuccess } from "../../../infrastructure/vbk-response-error.js";
import { buildSuggestDistrictRequest, SUGGEST_DISTRICT_ENDPOINT } from "../../../infrastructure/suggest-district.js";
import { isChinaCountryName, isProvinceLevelCityName, toPlatformShortLocationName } from "../../../../shared/location-short-name.js";

type Json = Record<string, any>;

export interface AdministrativeParentCity {
  /** 平台可写的县市名（松潘、九寨沟）。 */
  cityName: string;
  provinceName?: string;
  /** 命中的行政节点原名，用于报错说明。 */
  via: string;
}

const CITY_TYPE = /^city$/i;
const LOCALITY_TYPE = /^(?:town|township|sightzone|location|district|county)$/i;
const GATEWAY_SUFFIX = /(?:风景名胜区|风景区|景区|门口|入口|古镇|古城|县城|市区|附近|周边)$/u;

/** 落点名本身，以及去掉门户后缀后的主体地名（九寨沟沟口 → 九寨沟）。 */
export function localityStems(name: string): string[] {
  const stems = [name];
  if (name.endsWith("沟口")) {
    const stem = name.slice(0, -2);
    const valley = stem.endsWith("沟") ? stem : `${stem}沟`;
    if (stem.length >= 2) stems.push(valley);
  }
  const stripped = name.replace(GATEWAY_SUFFIX, "");
  if (stripped !== name && stripped.length >= 2) stems.push(stripped);
  return [...new Set(stems)];
}

function plainName(value: unknown): string {
  return toPlatformShortLocationName(String(value ?? "").trim().replace(/(?:镇|乡|街道)$/u, ""));
}

function nodeProvince(node: Json): string | undefined {
  const parents: Json[] = Array.isArray(node.parents) ? node.parents : [];
  const province = parents.find(parent => /^province$/i.test(String(parent.districtType)))?.districtName;
  if (province) return toPlatformShortLocationName(province);
  // 直辖市下辖区（万州区）的父链是 重庆(City) < 中国(Country)。
  const municipality = parents.find(parent => CITY_TYPE.test(String(parent.districtType)))?.districtName;
  return isProvinceLevelCityName(municipality) ? toPlatformShortLocationName(municipality) : undefined;
}

/** 在 suggestDistrict 响应里选出唯一的国内同名节点，并给出它的最近一级县市。 */
export function parentCityFromDistricts(payload: Json, stem: string, province?: string): AdministrativeParentCity | undefined {
  const lockedProvince = toPlatformShortLocationName(province);
  const districts: Json[] = Array.isArray(payload?.districts) ? payload.districts : [];
  const matches = districts.filter(node => Number(node.districtId) > 0
    && (CITY_TYPE.test(String(node.districtType)) || LOCALITY_TYPE.test(String(node.districtType)))
    && plainName(node.districtName) === plainName(stem)
    && (Array.isArray(node.parents) ? node.parents : []).some((parent: Json) =>
      /^country$/i.test(String(parent.districtType)) && isChinaCountryName(parent.districtName))
    && Boolean(nodeProvince(node))
    && (!lockedProvince || nodeProvince(node) === lockedProvince));
  if (matches.length !== 1) return undefined;
  const node = matches[0]!;
  const cityName = CITY_TYPE.test(String(node.districtType)) ? node.districtName
    : (node.parents as Json[]).find(parent => CITY_TYPE.test(String(parent.districtType)))?.districtName;
  if (!cityName) return undefined;
  // 保留平台原名：「理县」缩成「理」会命中外国城市。
  return { cityName: String(cityName).trim(), provinceName: nodeProvince(node), via: String(node.districtName) };
}

export async function resolveAdministrativeParentCity(page: any, name: string, province?: string): Promise<AdministrativeParentCity | undefined> {
  for (const stem of localityStems(name)) {
    const response = await vbkSessionRequest(page, {
      endpoint: SUGGEST_DISTRICT_ENDPOINT,
      body: buildSuggestDistrictRequest(stem),
      browserRequestTimeoutMs: 12_000,
      evaluateTimeoutMs: 15_000,
      errorLabel: "VBK 住宿地行政父级查询",
      includeCidQuery: false,
    });
    const parent = parentCityFromDistricts(assertVbkAckSuccess(response.payload, "VBK 住宿地行政父级查询") as Json, stem, province);
    if (parent && toPlatformShortLocationName(parent.cityName) !== toPlatformShortLocationName(name)) return parent;
  }
  return undefined;
}
