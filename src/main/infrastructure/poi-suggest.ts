import type {
  PoiSuggestDetailResult,
  PoiSuggestion,
} from "../../shared/contracts.js";
import type { PoiSuggestDetailResultWithRawPayload } from "./poi-suggest-detail.js";
import { buildPoiSuggestDetailResult } from "./poi-suggest-detail.js";
import { localizePoiListDistricts } from "./suggest-district.js";
import { vbkSessionRequest, VbkSessionRequestTimeoutError } from "./vbk-session-request.js";

export { flattenPoiTextFields } from "./poi-suggest-detail.js";

export interface PoiSuggestRequest {
  requestHeader: { locale: "zh-CN" };
  poiTypes: Array<{ key: number; name: string }>;
  count: 100;
  keyword: string;
  tagIds: [];
  useENameSort: "T";
  districtSortDto: PoiDistrictSortDto;
  contentType: "json";
}

export interface PoiDistrictSortDto {
  districtIds: number[];
  poiIds: number[];
}

export interface PoiSuggestDemoResult {
  httpStatus: number;
  businessStatus: string | number | boolean | null;
  poiListCount: number;
  best: PoiSuggestion | null;
}

export interface PoiSuggestBrowser {
  evaluate<T, A = unknown>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T>;
}

export interface PoiSuggestTimeoutOptions {
  /** 浏览器页内 fetch 的取消上限；默认 12 秒。 */
  browserRequestTimeoutMs?: number;
  /** BrowserView evaluate 自身悬挂时，主进程的兜底上限；默认 15 秒。 */
  evaluateTimeoutMs?: number;
  /** 自动补全 POI 时使用的产品地域上下文，用来剔除外地同名景点。 */
  destinationCity?: string;
  province?: string;
}

export class PoiSuggestTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PoiSuggestTimeoutError";
  }
}

const SUGGEST_POI_ENDPOINT = "https://online.ctrip.com/restapi/soa2/20049/suggestPoi";
export const POI_BROWSER_REQUEST_TIMEOUT_MS = 12_000;
export const POI_EVALUATE_TIMEOUT_MS = 15_000;

/** The stable VBK request contract; authentication stays in the logged-in BrowserView session. */
export function buildPoiSuggestRequest(keyword: string): PoiSuggestRequest {
  const trimmed = keyword.trim();
  if (!trimmed) throw new Error("POI 关键词不能为空");
  return {
    requestHeader: { locale: "zh-CN" },
    poiTypes: [
      { key: 3, name: "SIGHT" },
      { key: 19, name: "EDUCATION" },
      { key: 66, name: "SIGHTPLAY" },
      { key: 99, name: "ACTIVITIES" },
    ],
    count: 100,
    keyword: trimmed,
    tagIds: [],
    useENameSort: "T",
    districtSortDto: { districtIds: [], poiIds: [] },
    contentType: "json",
  };
}

export async function suggestPoiDemo(
  browser: PoiSuggestBrowser,
  keyword: string,
  options: PoiSuggestTimeoutOptions = {},
): Promise<PoiSuggestDemoResult> {
  const parsed = await queryPoiSuggest(browser, keyword, options);
  return {
    httpStatus: parsed.httpStatus,
    businessStatus: parsed.businessStatus,
    poiListCount: parsed.poiListCount,
    best: parsed.best,
  };
}

async function queryPoiSuggest(
  browser: PoiSuggestBrowser,
  keyword: string,
  options: PoiSuggestTimeoutOptions = {},
): Promise<PoiSuggestDetailResultWithRawPayload> {
  const request = buildPoiSuggestRequest(keyword);
  const browserRequestTimeoutMs = timeoutOrDefault(options.browserRequestTimeoutMs, POI_BROWSER_REQUEST_TIMEOUT_MS);
  const evaluateTimeoutMs = timeoutOrDefault(options.evaluateTimeoutMs, POI_EVALUATE_TIMEOUT_MS);
  let response;
  try {
    response = await vbkSessionRequest(browser, {
      endpoint: SUGGEST_POI_ENDPOINT,
      body: request,
      browserRequestTimeoutMs,
      evaluateTimeoutMs,
      errorLabel: "VBK POI 查询",
      includeCidQuery: false,
    });
  } catch (error) {
    if (error instanceof VbkSessionRequestTimeoutError) {
      throw new PoiSuggestTimeoutError(error.message);
    }
    throw error;
  }
  const payload = response.payload;
  const body = asRecord(payload);
  const data = asRecord(body?.data);
  const list = Array.isArray(body?.poiList) ? body.poiList : Array.isArray(data?.poiList) ? data.poiList : [];
  // suggestPoi 的 districtName 偶发英文；用 suggestDistrict 按 districtId 映回中文后再解析展示。
  await localizePoiListDistricts(browser, list, {
    browserRequestTimeoutMs,
    evaluateTimeoutMs,
  });
  return parsePoiSuggestPayload(keyword, payload, response.status, options);
}

export async function suggestPoiDetail(
  browser: PoiSuggestBrowser,
  keyword: string,
  options?: PoiSuggestTimeoutOptions,
): Promise<PoiSuggestDetailResult> {
  const { rawPayload: _rawPayload, ...detail } = await queryPoiSuggestWithDestinationFallback(browser, keyword, options);
  return detail;
}

export async function suggestPoiDetailWithRawPayload(
  browser: PoiSuggestBrowser,
  keyword: string,
  options?: PoiSuggestTimeoutOptions,
): Promise<PoiSuggestDetailResultWithRawPayload> {
  return queryPoiSuggest(browser, keyword, options);
}

export async function suggestPoi(
  browser: PoiSuggestBrowser,
  keyword: string,
  options?: PoiSuggestTimeoutOptions,
): Promise<PoiSuggestion | null> {
  return (await queryPoiSuggestWithDestinationFallback(browser, keyword, options)).best;
}

async function queryPoiSuggestWithDestinationFallback(
  browser: PoiSuggestBrowser,
  keyword: string,
  options: PoiSuggestTimeoutOptions = {},
): Promise<PoiSuggestDetailResultWithRawPayload> {
  const first = await queryPoiSuggest(browser, keyword, options);
  if (first.best) return first;
  const city = options.destinationCity?.trim() ?? "";
  const trimmedKeyword = keyword.trim();
  if (!city || !trimmedKeyword.startsWith(city) || trimmedKeyword.length <= city.length + 1) return first;
  // VBK often searches “北京故宫” as a literal string and returns a noisy
  // list. A second authenticated query for the city-local name lets the
  // strict matcher choose the canonical “故宫博物院” without guessing an ID.
  return queryPoiSuggest(browser, trimmedKeyword.slice(city.length).trim(), options);
}

export function parsePoiSuggestPayload(
  keyword: string,
  payload: unknown,
  httpStatus = 200,
  context?: { destinationCity?: string; province?: string },
): PoiSuggestDetailResultWithRawPayload {
  const body = asRecord(payload);
  const responseStatus = asRecord(body?.ResponseStatus);
  const ack = responseStatus?.Ack ?? null;
  if (!isBusinessSuccess(ack)) {
    throw new Error(`VBK POI 查询业务失败：${failureReason(responseStatus)}`);
  }
  const data = asRecord(body?.data);
  const list = Array.isArray(body?.poiList) ? body.poiList : Array.isArray(data?.poiList) ? data.poiList : [];
  const best = pickBestPoi(keyword, { poiList: list }, context)
    ?? (!hasLocationContext(context) ? pickBestPoi(keyword, {
      // A few live responses put valid names/IDs behind locale-specific
      // metadata that makes the raw context filter undecidable. Re-run the
      // strict name matcher on the already-sanitised identity projection;
      // 带产品地域时禁止使用这条无地域投影，否则外地完全同名 POI 会绕过
      // destinationCity / province 过滤。
      poiList: list.map((item) => ({ localName: candidatePoiName(item), poiId: positiveIntegerValue(asRecord(item)?.poiId) })),
    }) : null);
  return buildPoiSuggestDetailResult({
    httpStatus,
    businessStatus: ack as string | number | boolean | null,
    best,
    payload,
    poiList: list,
  });
}

export function pickBestPoi(
  keyword: string,
  payload: unknown,
  context?: { destinationCity?: string; province?: string },
): PoiSuggestion | null {
  // A combined itinerary stop is not a single POI.  Never let exact or broad
  // containment select one half of it; enrichment will create a research task
  // instead.  Candidate names may legitimately use brackets for aliases, so
  // this guard intentionally applies only to the requested keyword.
  if (hasMultiplePlaceNames(keyword)) return null;
  const list = asRecord(payload)?.poiList;
  const pois = Array.isArray(list) ? list : [];
  const key = normaliseName(keyword);
  if (!key) return null;
  const scopedPois = filterPoisByContext(pois, context);
  if (pois.length > 0 && scopedPois.length === 0) return null;
  const matchKeys = [key, stripDestinationPrefix(key, context?.destinationCity)]
    .filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index);
  // An explicit name always wins, including a specific sub-attraction. For a
  // non-exact request, however, prefer a uniquely verified official(alias)
  // POI before using broad containment: facilities can otherwise happen to
  // contain the whole keyword and win merely because of list order.
  const findHit = (pool: unknown[]) => {
    const exact = pool.find((item) => matchKeys.some((matchKey) => normaliseName(candidatePoiName(item)) === matchKey));
    return exact ?? matchKeys.map((matchKey) => pickConservativeAliasPoi(matchKey, pool)).find(Boolean) ?? pool.find((item) => {
      const rawName = candidatePoiName(item);
      const name = normaliseName(rawName);
      // Exact requests for a sub-attraction remain valid above.  A partial
      // main-attraction request must never be satisfied by one of its pits,
      // halls, entrances, etc., merely because the name happens to contain it.
      return !isSubAttraction(rawName) && matchKeys.some((matchKey) => isConservativeContainmentMatch(matchKey, name));
    });
  };
  // Some VBK responses expose English/partial district metadata even though
  // the product context is Chinese. If the city-prefixed name has a unique
  // exact/conservative match outside the filtered pool, use that name proof;
  // never fall back to the first arbitrary candidate.
  const hit = findHit(scopedPois)
    ?? (!hasLocationContext(context) && matchKeys.length > 1 ? findHit(pois) : null);
  const poi = asRecord(hit);
  const poiName = candidatePoiName(poi);
  const poiId = positiveIntegerValue(poi?.poiId);
  if (!poiName || poiId === undefined) return null;
  return { poiName, poiId };
}

function filterPoisByContext(pois: unknown[], context?: { destinationCity?: string; province?: string }): unknown[] {
  const destinationCity = normaliseLocationName(context?.destinationCity);
  const province = normaliseLocationName(context?.province);
  if (!destinationCity && !province) return pois;
  return pois.filter((item) => {
    const poi = asRecord(item);
    const locations = candidateLocationNames(poi);
    const candidateCity = locations.city;
    const candidateProvince = locations.province;
    if (candidateCity && destinationCity && locationNamesMatch(candidateCity, destinationCity)) return true;
    if (candidateProvince && province && locationNamesMatch(candidateProvince, province)) return true;
    // 候选没有地域字段时保留原有行为；有地域字段且明确不匹配时剔除，
    // 避免“南山风景区”这类泛名命中外省 POI。
    return !candidateCity && !candidateProvince;
  });
}

function hasLocationContext(context?: { destinationCity?: string; province?: string }): boolean {
  return Boolean(context?.destinationCity?.trim() || context?.province?.trim());
}

function candidateLocationNames(poi: Record<string, unknown> | null): { city: string; province: string } {
  const values = new Map<string, string>();
  const visit = (value: unknown) => {
    const record = asRecord(value);
    if (!record) return;
    const districtName = normaliseLocationName(record.districtName);
    const districtType = normaliseLocationName(record.districtType);
    // 当前 VBK locale=zh-CN 响应的 districtName 偶尔仍是英文（Beijing、Shanghai）。
    // 英文值无法与中文产品上下文安全比较，按未知地域处理，交给名称匹配/人工核查，
    // 不要把合法同城候选误判成外地候选。
    const isChineseLocation = /[\u3400-\u9fff]/.test(String(record.districtName ?? ""));
    if (districtName && isChineseLocation && districtType === "city") values.set("district.city", districtName);
    if (districtName && isChineseLocation && districtType === "province") values.set("district.province", districtName);
    for (const [key, child] of Object.entries(record)) {
      const normalised = normaliseLocationName(child);
      if (typeof child === "string" && normalised && /[\u3400-\u9fff]/.test(child)
        && /(?:city|province|districtname|provincename)$/i.test(key)) {
        values.set(key.toLowerCase(), normalised);
      }
      if (child && typeof child === "object") visit(child);
    }
  };
  visit(poi);
  const city = [...values.entries()].find(([key]) => /cityname|city$/.test(key))?.[1] ?? "";
  const province = [...values.entries()].find(([key]) => /provincename|province$/.test(key))?.[1] ?? "";
  return { city, province };
}

function stripDestinationPrefix(keyword: string, destinationCity?: string): string {
  const city = normaliseName(destinationCity ?? "");
  if (!city || !keyword.startsWith(city)) return keyword;
  const remainder = keyword.slice(city.length);
  return remainder.length >= 2 ? remainder : keyword;
}

/**
 * Some VBK canonical POIs expose a commonly-used scenic name only in brackets,
 * such as "官方名称(常用景点名)".  Accept that shape only when it is the unique
 * candidate, its official name and bracket alias together cover the requested
 * place, and it is not a clearly subordinate attraction.
 */
function pickConservativeAliasPoi(keyword: string, pois: unknown[]): Record<string, unknown> | null {
  if (hasMultiplePlaceNames(keyword)) return null;
  const keywordCore = removePlaceType(keyword);
  if (keywordCore.length < 4) return null;
  const matches = pois.flatMap((item) => {
    const poi = asRecord(item);
    const name = candidatePoiName(poi);
    if (!poi || !name || isSubAttraction(name)) return [];
    const parts = splitBracketAlias(name);
    if (!parts) return [];
    const [officialName, alias] = parts;
    const officialCore = removePlaceType(normaliseName(officialName));
    const aliasCore = removePlaceType(normaliseName(alias));
    const officialMatches = matchedKeywordPositions(keywordCore, officialCore);
    const aliasMatches = matchedKeywordPositions(keywordCore, aliasCore);
    const combinedMatches = new Set([...officialMatches, ...aliasMatches]);
    const officialOnly = [...officialMatches].filter((index) => !aliasMatches.has(index)).length;
    const aliasOnly = [...aliasMatches].filter((index) => !officialMatches.has(index)).length;
    // Each half must independently identify the same place; combined coverage
    // must be disjoint enough to cover the requested place.  Counting LCS
    // lengths alone can count the same keyword characters twice.
    if (officialMatches.size < 3 || aliasMatches.size < 2
      || officialOnly < 3 || aliasOnly < 2 || combinedMatches.size !== keywordCore.length) return [];
    return [poi];
  });
  return matches.length === 1 ? matches[0] : null;
}

function splitBracketAlias(name: string): [string, string] | null {
  const match = name.match(/^(.+?)[(（]([^()（）]+)[)）]$/);
  if (!match) return null;
  const officialName = match[1].trim();
  const alias = match[2].trim();
  return officialName && alias ? [officialName, alias] : null;
}

function hasMultiplePlaceNames(name: string): boolean {
  return /[·、,，/]/.test(name) || /(?:和|与|及)/.test(name);
}

function isSubAttraction(name: string): boolean {
  // Keep this deliberately limited to facilities and clearly secondary
  // attractions. Exact-name selection is handled before this guard, so a
  // user who explicitly asks for (for example) a statue can still select it.
  return /(?:[一二三四五六七八九十百\d]+号|陪葬坑|院史|陈列|展览|展厅|售票处|停车场|入口|出口|山门|凉亭|楼|阁|塔|寺|殿|台|苑|园|碑林|救生会|观景台|服务中心|雕像|塑像|纪念碑)/.test(name);
}

function isConservativeContainmentMatch(keyword: string, candidate: string): boolean {
  const keywordCore = removePlaceType(keyword);
  const candidateCore = removePlaceType(candidate);
  if (!keywordCore || !candidateCore) return false;
  if (keywordCore === candidateCore) return true;

  // 允许“鼋头渚”匹配“无锡市太湖鼋头渚风景区”这类带明确行政区
  // 前缀的官方主景点名；拒绝“金山风景区”匹配“夹金山/布金山”。
  if (candidateCore.endsWith(keywordCore)) {
    const prefix = candidateCore.slice(0, -keywordCore.length);
    return /(?:省|市|区|县|州|盟|旗)/.test(prefix);
  }
  return false;
}

function removePlaceType(name: string): string {
  return name.replace(/(?:广播电视塔|电视塔|步行街|商业街|博物馆|博物院|民俗风貌区|风景名胜区|风景区|景区|公园|遗址)$/g, "");
}

function matchedKeywordPositions(keyword: string, candidate: string): Set<number> {
  const scores = Array.from({ length: keyword.length + 1 }, () => Array<number>(candidate.length + 1).fill(0));
  for (let keywordIndex = 1; keywordIndex <= keyword.length; keywordIndex += 1) {
    for (let candidateIndex = 1; candidateIndex <= candidate.length; candidateIndex += 1) {
      scores[keywordIndex][candidateIndex] = keyword[keywordIndex - 1] === candidate[candidateIndex - 1]
        ? scores[keywordIndex - 1][candidateIndex - 1] + 1
        : Math.max(scores[keywordIndex - 1][candidateIndex], scores[keywordIndex][candidateIndex - 1]);
    }
  }
  const positions = new Set<number>();
  let keywordIndex = keyword.length;
  let candidateIndex = candidate.length;
  while (keywordIndex > 0 && candidateIndex > 0) {
    if (keyword[keywordIndex - 1] === candidate[candidateIndex - 1]) {
      positions.add(keywordIndex - 1);
      keywordIndex -= 1;
      candidateIndex -= 1;
    } else if (scores[keywordIndex - 1][candidateIndex] >= scores[keywordIndex][candidateIndex - 1]) {
      keywordIndex -= 1;
    } else {
      candidateIndex -= 1;
    }
  }
  return positions;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * suggestPoi 的线上响应以 `name` 为主；旧 fixture 和部分响应仍使用
 * `poiName`。统一在选择边界兼容两种字段，避免跳过列表中的精确候选，
 * 继而按顺序误选名称包含关键词的下属景点。
 */
function candidatePoiName(value: unknown): string {
  const poi = asRecord(value);
  // 部分 VBK 会话会把 poiName 本地化成英文，同时保留中文 localName。
  // 规划关键词是中文，优先使用 localName；旧响应仍回退 poiName/name。
  return String(poi?.localName ?? poi?.poiName ?? poi?.name ?? "").trim();
}

function isBusinessSuccess(ack: unknown): boolean {
  return ack === "Success" || ack === "SUCCESS" || ack === true || ack === "true";
}

function positiveIntegerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function failureReason(status: Record<string, unknown> | null): string {
  const errors = Array.isArray(status?.Errors) ? status.Errors : [];
  const first = asRecord(errors[0]);
  const reason = first?.Message ?? first?.message ?? first?.Code ?? status?.Ack ?? "ResponseStatus 未确认成功";
  return String(reason).replace(/[\r\n\t]/g, " ").slice(0, 300);
}

function normaliseName(value: string): string {
  return value.replace(/[（）()\s]/g, "").toLowerCase();
}

function normaliseLocationName(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/维吾尔自治区|壮族自治区|回族自治区|自治区|特别行政区|省|市|地区|盟|州|自治州/g, "")
    .replace(/[（）()\s]/g, "")
    .toLowerCase();
}

function locationNamesMatch(candidate: string, expected: string): boolean {
  return candidate === expected || candidate.includes(expected) || expected.includes(candidate);
}

function timeoutOrDefault(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : fallback;
}
