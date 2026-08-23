/**
 * VBK 行政区建议：POST /restapi/soa2/20049/suggestDistrict
 * 用于把 suggestPoi 偶发返回的英文 districtName（如 Gyantse）按 districtId 映回中文（江孜）。
 */
import { vbkSessionRequest, VbkSessionRequestTimeoutError, type VbkSessionRequestBrowser } from "./vbk-session-request.js";

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
 * 若 poiList 的 district.districtName 为英文，则用同名 keyword 调 suggestDistrict，
 * 按 districtId 回写中文 districtName / parents。失败时保留原文，不阻断 POI 查询。
 */
const LOCALIZE_CONCURRENCY = 4;
const LOCALIZE_MAX_JOBS = 12;

export async function localizePoiListDistricts(
  browser: VbkSessionRequestBrowser,
  poiList: unknown[],
  options: { browserRequestTimeoutMs?: number; evaluateTimeoutMs?: number } = {},
): Promise<void> {
  const jobs = collectAsciiDistrictJobs(poiList).slice(0, LOCALIZE_MAX_JOBS);
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
        if (hit) resolved.set(job.districtId, hit);
      } catch {
        // 映射失败时保留英文原文，由展示层继续用 districtId/英文区分。
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(LOCALIZE_CONCURRENCY, jobs.length) }, () => worker()));
  if (resolved.size === 0) return;
  applyLocalizedDistricts(poiList, resolved);
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
    if (!localized) continue;
    district.districtName = localized.districtName;
    if (localized.districtType) district.districtType = localized.districtType;
    if (localized.parents) district.parents = localized.parents;
  }
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
