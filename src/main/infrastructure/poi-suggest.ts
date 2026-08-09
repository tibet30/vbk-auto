export interface PoiSuggestion { poiName: string; poiId: string }

export interface PoiSuggestRequest {
  requestHeader: { locale: "zh-CN" };
  poiTypes: Array<{ key: number; name: string }>;
  count: 100;
  keyword: string;
  tagIds: [];
  useENameSort: "T";
  districtSortDto: { districtIds: []; poiIds: [number, number, number] };
  contentType: "json";
}

export interface PoiSuggestDemoResult {
  httpStatus: number;
  businessStatus: string | number | boolean | null;
  poiListCount: number;
  best: PoiSuggestion | null;
}

export interface PoiSuggestTimeoutOptions {
  /** 浏览器页内 fetch 的取消上限；默认 12 秒。 */
  browserRequestTimeoutMs?: number;
  /** BrowserView evaluate 自身悬挂时，主进程的兜底上限；默认 15 秒。 */
  evaluateTimeoutMs?: number;
}

export class PoiSuggestTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PoiSuggestTimeoutError";
  }
}

interface PoiSuggestBrowser {
  evaluate<T, A = unknown>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T>;
}

interface BrowserResponse {
  status: number;
  text: string;
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
    districtSortDto: { districtIds: [], poiIds: [93331, 79413, 118386477] },
    contentType: "json",
  };
}

export async function suggestPoiDemo(
  browser: PoiSuggestBrowser,
  keyword: string,
  options: PoiSuggestTimeoutOptions = {},
): Promise<PoiSuggestDemoResult> {
  const request = buildPoiSuggestRequest(keyword);
  const browserRequestTimeoutMs = timeoutOrDefault(options.browserRequestTimeoutMs, POI_BROWSER_REQUEST_TIMEOUT_MS);
  const evaluateTimeoutMs = timeoutOrDefault(options.evaluateTimeoutMs, POI_EVALUATE_TIMEOUT_MS);
  const evaluation = browser.evaluate(async ({ endpoint, request: body, timeoutMs }: {
    endpoint: string;
    request: PoiSuggestRequest;
    timeoutMs: number;
  }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const result = await fetch(endpoint, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json;charset=UTF-8" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      return { status: result.status, text: await result.text() };
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`VBK POI 浏览器请求超时（${timeoutMs}ms）`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }, { endpoint: SUGGEST_POI_ENDPOINT, request, timeoutMs: browserRequestTimeoutMs });
  const response = await rejectAfter(evaluation, evaluateTimeoutMs, `VBK POI BrowserView 执行超时（${evaluateTimeoutMs}ms）`) as BrowserResponse;
  if (response.status < 200 || response.status >= 300) throw new Error(`VBK POI 查询 HTTP ${response.status}`);

  let body: unknown;
  try { body = JSON.parse(response.text); }
  catch { throw new Error("VBK POI 查询返回无效 JSON"); }
  return parsePoiSuggestPayload(keyword, body, response.status);
}

export async function suggestPoi(
  browser: PoiSuggestBrowser,
  keyword: string,
  options?: PoiSuggestTimeoutOptions,
): Promise<PoiSuggestion | null> {
  return (await suggestPoiDemo(browser, keyword, options)).best;
}

export function parsePoiSuggestPayload(keyword: string, payload: unknown, httpStatus = 200): PoiSuggestDemoResult {
  const body = asRecord(payload);
  const responseStatus = asRecord(body?.ResponseStatus);
  const ack = responseStatus?.Ack ?? null;
  if (!isBusinessSuccess(ack)) {
    throw new Error(`VBK POI 查询业务失败：${failureReason(responseStatus)}`);
  }
  const data = asRecord(body?.data);
  const list = Array.isArray(body?.poiList) ? body.poiList : Array.isArray(data?.poiList) ? data.poiList : [];
  return { httpStatus, businessStatus: ack as string | number | boolean | null, poiListCount: list.length, best: pickBestPoi(keyword, { poiList: list }) };
}

export function pickBestPoi(keyword: string, payload: unknown): PoiSuggestion | null {
  // A combined itinerary stop is not a single POI.  Never let exact or broad
  // containment select one half of it; enrichment will create a research task
  // instead.  Candidate names may legitimately use brackets for aliases, so
  // this guard intentionally applies only to the requested keyword.
  if (hasMultiplePlaceNames(keyword)) return null;
  const list = asRecord(payload)?.poiList;
  const pois = Array.isArray(list) ? list : [];
  const key = normaliseName(keyword);
  if (!key) return null;
  // An explicit name always wins, including a specific sub-attraction. For a
  // non-exact request, however, prefer a uniquely verified official(alias)
  // POI before using broad containment: facilities can otherwise happen to
  // contain the whole keyword and win merely because of list order.
  const exact = pois.find((item) => normaliseName(String(asRecord(item)?.poiName ?? "")) === key);
  const hit = exact ?? pickConservativeAliasPoi(key, pois) ?? pois.find((item) => {
      const rawName = String(asRecord(item)?.poiName ?? "").trim();
      const name = normaliseName(rawName);
      // Exact requests for a sub-attraction remain valid above.  A partial
      // main-attraction request must never be satisfied by one of its pits,
      // halls, entrances, etc., merely because the name happens to contain it.
      return !isSubAttraction(rawName) && (name.includes(key) || key.includes(name));
    });
  const poi = asRecord(hit);
  if (!poi || !String(poi.poiName ?? "").trim() || !String(poi.poiId ?? "").trim()) return null;
  return { poiName: String(poi.poiName).trim(), poiId: String(poi.poiId).trim() };
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
    const name = String(poi?.poiName ?? "").trim();
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
  return /(?:[一二三四五六七八九十百\d]+号|陪葬坑|院史|陈列|展览|展厅|售票处|停车场|入口|出口|观景台|服务中心|雕像|塑像|纪念碑)/.test(name);
}

function removePlaceType(name: string): string {
  return name.replace(/(?:博物馆|博物院|风景名胜区|风景区|景区|公园|遗址)$/g, "");
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

function isBusinessSuccess(ack: unknown): boolean {
  return ack === "Success" || ack === "SUCCESS" || ack === true || ack === "true";
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

function timeoutOrDefault(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : fallback;
}

function rejectAfter<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new PoiSuggestTimeoutError(message)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}
