/**
 * 三人同游平台在售服务的「参考比对」：给本地产品找平台侧可能对应的服务，作为定价参考。
 *
 * 三条硬边界：
 *  - **只读、只参考**：结果不写进产品事实，不参与程序检查与运营确认，也不改变任何状态机；
 *  - **不编造匹配**：城市来自平台字典（中文名 → code），标题相似度用二元组重叠率；
 *    达不到阈值就是「未找到」，不拿远房服务凑数；
 *  - **失败如实说**：未配置令牌、没身份（403）、网络故障分别给出不同说明，不伪装成「没有同类服务」。
 */

import type { TibetServiceClient, TibetCatalogService } from "./tibet-service-client.js";
import { TibetServiceAuthError, TibetServiceScopeError } from "./tibet-service-transport.js";

/** 城市字典缓存时长；平台字典变动很慢，10 分钟足够且不会把请求放大。 */
const DICTIONARY_TTL_MS = 10 * 60 * 1000;
/** 标题相似度阈值：低于它就认为不是同一个玩法。 */
const MIN_TITLE_SIMILARITY = 0.34;
const MAX_MATCHES = 5;

export interface PlatformReferenceInput {
  /** 产品标题（basicInfo.title 回退到本地产品名）。 */
  title: string;
  meetingCity?: string;
  destinationCity?: string;
  days?: number;
  /** 产品成人价，用于给参考价做差价提示；缺失则不比较。 */
  adultPrice?: number | null;
}

export interface PlatformReferenceMatch {
  publicId: string;
  title: string;
  priceFrom: number | null;
  cityCode: string | null;
  cityName: string | null;
  serviceType: string | null;
  durationLabel: string | null;
  similarity: number;
  /** 与产品成人价的差值（平台起价 - 产品成人价）；缺任一侧时为 null。 */
  priceGap: number | null;
  reasons: string[];
}

export interface PlatformReferenceResult {
  configured: boolean;
  query: {
    title: string;
    cities: string[];
    cityCodes: string[];
    days: number | null;
  };
  matches: PlatformReferenceMatch[];
  message: string;
}

interface DictionaryCity {
  code: string;
  name: string;
}

/** 平台城市字典的内存缓存（按客户端共享）。 */
const cityDictionaryCache = new WeakMap<TibetServiceClient, { at: number; cities: DictionaryCity[] }>();

/**
 * 城市名归一：平台字典里的城市名是短名（`广州`、`日喀则`），产品里可能带「市」。
 * 只去掉尾部「市」——不能把「州 / 区 / 县」也剥掉，否则「广州」会被削成「广」。
 */
export function normalizePlaceName(value: string | undefined | null): string {
  return (value ?? "").trim().replace(/市$/u, "").trim();
}

/** 中日韩文字二元组；数字与标点不参与，避免「2天」把不同玩法连起来。 */
export function titleGrams(value: string): Set<string> {
  const grams = new Set<string>();
  const runs = value.normalize("NFKC").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (const run of runs) {
    // 数字是分隔符而不是内容：「2天1晚」应当只留下「天」「晚」两段单字，不产生「天晚」这种假词。
    for (const cjk of run.split(/[\p{N}]+/u)) {
      if (cjk.length < 2) continue;
      for (let i = 0; i < cjk.length - 1; i += 1) grams.add(cjk.slice(i, i + 2));
    }
  }
  return grams;
}

export function titleSimilarity(left: string, right: string): number {
  const a = titleGrams(left);
  const b = titleGrams(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

async function loadCityDictionary(client: TibetServiceClient): Promise<DictionaryCity[]> {
  const cached = cityDictionaryCache.get(client);
  if (cached && Date.now() - cached.at < DICTIONARY_TTL_MS) return cached.cities;
  const raw = await client.listDictionaries();
  const cities = raw.filter((item) => item.code && item.name);
  cityDictionaryCache.set(client, { at: Date.now(), cities });
  return cities;
}

function cityCodesFor(cities: readonly string[], dictionary: readonly DictionaryCity[]): string[] {
  const codes: string[] = [];
  for (const city of cities) {
    const needle = normalizePlaceName(city);
    if (!needle) continue;
    const hit = dictionary.find((item) => normalizePlaceName(item.name) === needle)
      ?? dictionary.find((item) => normalizePlaceName(item.name).includes(needle) || needle.includes(normalizePlaceName(item.name)));
    if (hit && !codes.includes(hit.code)) codes.push(hit.code);
  }
  return codes;
}

function cityNameOf(code: string | null, dictionary: readonly DictionaryCity[]): string | null {
  if (!code) return null;
  return dictionary.find((item) => item.code === code)?.name ?? null;
}

function dedupe(services: readonly TibetCatalogService[]): TibetCatalogService[] {
  const seen = new Set<string>();
  const result: TibetCatalogService[] = [];
  for (const service of services) {
    if (seen.has(service.publicId)) continue;
    seen.add(service.publicId);
    result.push(service);
  }
  return result;
}

function scoreOf(
  service: TibetCatalogService,
  input: PlatformReferenceInput,
  cityCodes: readonly string[],
): { similarity: number; reasons: string[]; accepted: boolean } {
  const reasons: string[] = [];
  const similarity = titleSimilarity(input.title, service.title);
  const sameCity = Boolean(service.cityCode && cityCodes.includes(service.cityCode));
  if (sameCity) reasons.push("同城");
  if (similarity >= MIN_TITLE_SIMILARITY) reasons.push(`标题相似 ${Math.round(similarity * 100)}%`);
  const accepted = sameCity ? similarity >= 0.15 : similarity >= MIN_TITLE_SIMILARITY;
  return { similarity, reasons, accepted };
}

export async function buildPlatformReference(
  client: TibetServiceClient,
  input: PlatformReferenceInput,
): Promise<PlatformReferenceResult> {
  const title = input.title.trim();
  const cities = [normalizePlaceName(input.meetingCity), normalizePlaceName(input.destinationCity)]
    .filter((city, index, all) => Boolean(city) && all.indexOf(city) === index);
  const query = { title, cities, cityCodes: [] as string[], days: input.days ?? null };

  if (!client.configured()) {
    return {
      configured: false,
      query,
      matches: [],
      message: "未配置三人同游服务令牌，无法比对平台在售服务。",
    };
  }
  if (!title) {
    return { configured: true, query, matches: [], message: "产品还没有标题，无法比对平台服务。" };
  }

  let dictionary: DictionaryCity[] = [];
  try {
    dictionary = await loadCityDictionary(client);
  } catch (error) {
    // 字典失败不致命：退化为按标题关键词比对。
    if (error instanceof TibetServiceAuthError || error instanceof TibetServiceScopeError) throw error;
  }
  const cityCodes = cityCodesFor(cities, dictionary);
  query.cityCodes = cityCodes;

  const searches: Array<Promise<{ items: TibetCatalogService[] }>> = [];
  for (const code of cityCodes) searches.push(client.listServices({ city: code, pageSize: 20 }));
  searches.push(client.listServices({ search: title, pageSize: 20 }));
  const settled = await Promise.allSettled(searches);
  const failures = settled.filter((item) => item.status === "rejected");
  if (failures.length === settled.length) {
    const first = failures[0] as PromiseRejectedResult;
    throw first.reason;
  }

  const pool = dedupe(
    settled
      .filter((item): item is PromiseFulfilledResult<{ items: TibetCatalogService[] }> => item.status === "fulfilled")
      .flatMap((item) => item.value.items),
  );

  const matches: PlatformReferenceMatch[] = [];
  for (const service of pool) {
    const scored = scoreOf(service, input, cityCodes);
    if (!scored.accepted) continue;
    const adult = typeof input.adultPrice === "number" ? input.adultPrice : null;
    matches.push({
      publicId: service.publicId,
      title: service.title,
      priceFrom: service.priceFrom,
      cityCode: service.cityCode,
      cityName: cityNameOf(service.cityCode, dictionary),
      serviceType: service.serviceType,
      durationLabel: service.durationLabel,
      similarity: Math.round(scored.similarity * 100) / 100,
      priceGap: typeof service.priceFrom === "number" && adult !== null
        ? Math.round((service.priceFrom - adult) * 100) / 100
        : null,
      reasons: scored.reasons,
    });
  }
  matches.sort((left, right) => right.similarity - left.similarity);

  const shown = matches.slice(0, MAX_MATCHES);
  const cityText = cities.length ? cities.join("、") : "（产品未填城市）";
  const message = shown.length
    ? `按城市 ${cityText} 与标题相似度比对，命中 ${shown.length} 条平台在售服务（仅供参考，不参与程序检查与运营确认）。`
    : `没有找到与「${title}」相近的平台在售服务（比对城市：${cityText}）。`;

  return { configured: true, query, matches: shown, message };
}
