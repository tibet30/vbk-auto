/**
 * VBK 行政区建议：POST /restapi/soa2/20049/suggestDistrict
 * 按 districtId 补全 suggestPoi 缺失的行政父链，并把偶发英文地名映回中文。
 */
import { vbkSessionRequest, VbkSessionRequestTimeoutError, type VbkSessionRequestBrowser } from "./vbk-session-request.js";
import {
  isChinaCountryName,
  isProvinceLevelCityName,
  toPlatformShortLocationName,
} from "../../shared/location-short-name.js";

export const SUGGEST_DISTRICT_ENDPOINT = "https://online.ctrip.com/restapi/soa2/20049/suggestDistrict";

export interface SuggestDistrictRequest {
  requestHeader: { locale: "zh-CN" };
  keyword: string;
  contentType: "json";
}

export interface SuggestDistrictNode {
  districtId: number;
  districtName: string;
  districtType?: string;
  parents?: SuggestDistrictNode[];
}

export function buildSuggestDistrictRequest(keyword: string): SuggestDistrictRequest {
  const trimmed = keyword.trim();
  if (!trimmed) throw new Error("行政区关键词不能为空");
  return {
    requestHeader: { locale: "zh-CN" },
    keyword: trimmed,
    contentType: "json",
  };
}

export function isAsciiLocationName(value: unknown): boolean {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return false;
  return !/[\u3400-\u9fff]/.test(text);
}

/** 从 suggestDistrict 响应中按 districtId 精确命中一条。 */
export function pickDistrictById(payload: unknown, districtId: number): SuggestDistrictNode | null {
  const root = asRecord(payload);
  const status = asRecord(root?.ResponseStatus);
  if (!["Success", "SUCCESS", true, "true"].includes(status?.Ack as string | boolean)) return null;
  const list = Array.isArray(root?.districts) ? root.districts : [];
  for (const item of list) {
    const record = asRecord(item);
    const id = positiveInteger(record?.districtId);
    const name = stringValue(record?.districtName);
    if (id === districtId && name) {
      return {
        districtId: id,
        districtName: name,
        districtType: stringValue(record?.districtType) ?? undefined,
        parents: mapParents(record?.parents),
      };
    }
  }
  return null;
}

/**
 * 行政父链残缺或 districtName 为英文时，用原 districtName 调 suggestDistrict，
 * 仅按 districtId 精确命中完整层级后回写。失败时保留原文，由地域门禁严格判定。
 */
const LOCALIZE_CONCURRENCY = 4;
const LOCALIZE_MAX_JOBS = 12;

export async function localizePoiListDistricts(
  browser: VbkSessionRequestBrowser,
  poiList: unknown[],
  options: { browserRequestTimeoutMs?: number; evaluateTimeoutMs?: number; province?: string } = {},
): Promise<void> {
  const jobs = collectDistrictRecoveryJobs(poiList, options.province).slice(0, LOCALIZE_MAX_JOBS);
  if (jobs.length === 0) return;

  const resolved = new Map<number, SuggestDistrictNode>();
  let cursor = 0;
  const worker = async () => {
    while (cursor < jobs.length) {
      const index = cursor;
      cursor += 1;
      const job = jobs[index];
      if (resolved.has(job.districtId)) continue;
      try {
        const payload = await fetchSuggestDistrict(browser, job.keyword, {
          browserRequestTimeoutMs: Math.min(options.browserRequestTimeoutMs ?? 8_000, 8_000),
          evaluateTimeoutMs: Math.min(options.evaluateTimeoutMs ?? 10_000, 10_000),
        });
        const hit = pickDistrictById(payload, job.districtId);
        if (hit && hasCompleteParentHierarchy(hit)) resolved.set(job.districtId, hit);
      } catch {
        // 映射失败时保留英文原文，由展示层继续用 districtId/英文区分。
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(LOCALIZE_CONCURRENCY, jobs.length) }, () => worker()));
  if (resolved.size === 0) return;
  applyLocalizedDistricts(poiList, resolved);
}

function collectDistrictRecoveryJobs(
  poiList: unknown[],
  provinceContext?: string,
): Array<{ districtId: number; keyword: string }> {
  const jobs = new Map<number, { keyword: string; count: number; incomplete: boolean; first: number }>();
  poiList.forEach((item, first) => {
    const district = asRecord(asRecord(item)?.district);
    const districtId = positiveInteger(district?.districtId);
    const keyword = stringValue(district?.districtName);
    if (!district || !districtId || !keyword) return;
    const incomplete = !hasCompleteParentHierarchy(district);
    const ascii = isAsciiLocationName(keyword);
    if (!incomplete && !ascii) return;
    if (provinceContext && hierarchyClosesOutsideRecovery(district, provinceContext)) return;
    if (!ascii && !provinceContext) return;
    const existing = jobs.get(districtId);
    if (existing) {
      existing.count += 1;
      existing.incomplete ||= incomplete;
    } else {
      jobs.set(districtId, { keyword, count: 1, incomplete, first });
    }
  });
  return [...jobs.entries()]
    .sort((left, right) => Number(right[1].incomplete) - Number(left[1].incomplete)
      || right[1].count - left[1].count || left[1].first - right[1].first)
    .map(([districtId, value]) => ({ districtId, keyword: value.keyword }));
}

/**
 * 已有省级证据与规划省份冲突，或父链已经明确终止于国家层级时，不再追查缺失省份。
 * 后者覆盖直辖市、特别行政区及外国行政区；这里只决定是否查询，不把规划上下文写入候选。
 */
function hierarchyClosesOutsideRecovery(district: Record<string, unknown>, provinceContext: string): boolean {
  const parents = Array.isArray(district.parents) ? district.parents.map(asRecord).filter(Boolean) : [];
  const province = parents.find(parent => stringValue(parent?.districtType)?.toLowerCase() === "province"
    && stringValue(parent?.districtName));
  if (province) {
    return toPlatformShortLocationName(stringValue(province.districtName) ?? "")
      !== toPlatformShortLocationName(provinceContext);
  }
  const country = parents.find(parent => stringValue(parent?.districtType)?.toLowerCase() === "country"
    && stringValue(parent?.districtName));
  if (!country) return false;
  if (!isChinaCountryName(country.districtName)) return true;
  const currentType = stringValue(district.districtType)?.toLowerCase();
  const currentName = currentType === "city" ? stringValue(district.districtName) : null;
  const parentCity = parents.find(parent => stringValue(parent?.districtType)?.toLowerCase() === "city"
    && stringValue(parent?.districtName));
  return isProvinceLevelCityName(stringValue(parentCity?.districtName) ?? currentName);
}

export function collectAsciiDistrictJobs(poiList: unknown[]): Array<{ districtId: number; keyword: string }> {
  const jobs = new Map<number, { keyword: string; count: number }>();
  for (const item of poiList) {
    const district = asRecord(asRecord(item)?.district);
    const districtId = positiveInteger(district?.districtId);
    const keyword = stringValue(district?.districtName);
    if (!districtId || !keyword || !isAsciiLocationName(keyword)) continue;
    const existing = jobs.get(districtId);
    if (existing) existing.count += 1;
    else jobs.set(districtId, { keyword, count: 1 });
  }
  // 高频 district 优先映射，保证列表顶部候选更快拿到中文名。
  return [...jobs.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([districtId, value]) => ({ districtId, keyword: value.keyword }));
}

export function applyLocalizedDistricts(
  poiList: unknown[],
  resolved: Map<number, SuggestDistrictNode>,
): void {
  for (const item of poiList) {
    const poi = asRecord(item);
    const district = asRecord(poi?.district);
    const districtId = positiveInteger(district?.districtId);
    if (!districtId || !district) continue;
    const localized = resolved.get(districtId);
    if (!localized || !hasCompleteParentHierarchy(localized)
      || !hierarchyCompatible(district, localized)) continue;
    district.districtName = localized.districtName;
    if (localized.districtType) district.districtType = localized.districtType;
    if (localized.parents) district.parents = localized.parents;
  }
}

function hasCompleteParentHierarchy(value: Record<string, unknown> | SuggestDistrictNode): boolean {
  const parents = Array.isArray(value.parents) ? value.parents.map(asRecord).filter(Boolean) : [];
  const types = new Set(parents.flatMap(parent => {
    const type = stringValue(parent?.districtType)?.toLowerCase();
    return type && stringValue(parent?.districtName) ? [type] : [];
  }));
  const currentType = stringValue(value.districtType)?.toLowerCase();
  const currentCity = currentType === "city" && Boolean(stringValue(value.districtName));
  return (types.has("city") || currentCity) && types.has("province");
}

function hierarchyCompatible(current: Record<string, unknown>, replacement: SuggestDistrictNode): boolean {
  const identity = (parents: unknown) => new Map((Array.isArray(parents) ? parents : []).flatMap(item => {
    const node = asRecord(item);
    const type = stringValue(node?.districtType)?.toLowerCase();
    const id = positiveInteger(node?.districtId);
    const name = stringValue(node?.districtName);
    return type && name && ["city", "province"].includes(type)
      ? [[type, { id, name }] as const] : [];
  }));
  const before = identity(current.parents);
  const after = identity(replacement.parents);
  return ["city", "province"].every(type => {
    const existing = before.get(type);
    const recovered = after.get(type);
    if (!existing) return true;
    if (!recovered) return false;
    return existing.id ? existing.id === recovered.id : existing.name === recovered.name;
  });
}

async function fetchSuggestDistrict(
  browser: VbkSessionRequestBrowser,
  keyword: string,
  options: { browserRequestTimeoutMs?: number; evaluateTimeoutMs?: number },
): Promise<unknown> {
  try {
    const response = await vbkSessionRequest(browser, {
      endpoint: SUGGEST_DISTRICT_ENDPOINT,
      body: buildSuggestDistrictRequest(keyword),
      browserRequestTimeoutMs: options.browserRequestTimeoutMs ?? 12_000,
      evaluateTimeoutMs: options.evaluateTimeoutMs ?? 15_000,
      errorLabel: "VBK 行政区查询",
      includeCidQuery: false,
    });
    return response.payload;
  } catch (error) {
    if (error instanceof VbkSessionRequestTimeoutError) throw error;
    throw error;
  }
}

function mapParents(value: unknown): SuggestDistrictNode[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parents: SuggestDistrictNode[] = [];
  for (const item of value) {
    const record = asRecord(item);
    const districtId = positiveInteger(record?.districtId);
    const districtName = stringValue(record?.districtName);
    if (!districtId || !districtName) continue;
    parents.push({
      districtId,
      districtName,
      districtType: stringValue(record?.districtType) ?? undefined,
    });
  }
  return parents;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  const text = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  return text || null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}
