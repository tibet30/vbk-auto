/**
 * POI 候选的"名字 → 最佳匹配"逻辑：
 *   - pickBestPoi：组合多种匹配策略（精确、保守别名、行政区前缀保守包含）；
 *   - 所有辅助函数（filter / hasMultiple / isSubAttraction / matchedKeywordPositions
 *     等）都在本文件内部，不污染对外接口。
 *
 * 与 parse.ts 互不耦合：parse 调用本文件 pickBestPoi，本文件不调 parse。
 */

import type { PoiSuggestion } from "../../../shared/contracts.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function candidatePoiName(value: unknown): string {
  const poi = asRecord(value);
  return String(poi?.localName ?? poi?.poiName ?? poi?.name ?? "").trim();
}

function positiveIntegerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
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
    // 避免"南山风景区"这类泛名命中外省 POI。
    return !candidateCity && !candidateProvince;
  });
}

function hasLocationContext(context?: { destinationCity?: string; province?: string }): boolean {
  return Boolean(context?.destinationCity?.trim() || context?.province?.trim());
}

function candidateLocationNames(poi: Record<string, unknown> | null): { city: string; province: string } {
  const values = new Map<string, string>();
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
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

  // 允许"鼋头渚"匹配"无锡市太湖鼋头渚风景区"这类带明确行政区
  // 前缀的官方主景点名；拒绝"金山风景区"匹配"夹金山/布金山"。
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