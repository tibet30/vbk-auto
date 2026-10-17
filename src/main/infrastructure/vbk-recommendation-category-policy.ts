import type {
  RecommendationCategoryDirectoryItem,
  RecommendationCategoryPolicy,
} from "../../shared/recommendation-category-policy.js";
import {
  vbkSessionRequest,
  type VbkSessionRequestBrowser,
  type VbkSessionRequestResult,
} from "./vbk-session-request.js";

const QCONFIG_ENDPOINT = "https://vbooking.ctrip.com/product/input/qconfig/tripInputLimitConfig";
const CATEGORY_ENDPOINT = "https://online.ctrip.com/restapi/soa2/15638/getpmrcmdcategory.json";

type Json = Record<string, any>;

export async function queryRecommendationCategoryPolicy(
  page: VbkSessionRequestBrowser,
  input: { productPatternId: number; inputLocale?: string; activeTagIds?: readonly number[] },
): Promise<RecommendationCategoryPolicy> {
  const [configResult, directoryResult] = await Promise.all([
    request(page, QCONFIG_ENDPOINT),
    request(page, CATEGORY_ENDPOINT),
  ]);
  assertSuccess(configResult, "推荐理由类别策略");
  assertSuccess(directoryResult, "推荐理由类别目录");
  const config = record(record(configResult.payload)?.data) ?? record(configResult.payload);
  const recommendReason = record(record(config?.scope)?.recommendReason) ?? record(config?.recommendReason);
  const directory = parseDirectory(directoryResult.payload);
  return deriveRecommendationCategoryPolicy(recommendReason, directory, input);
}

export function deriveRecommendationCategoryPolicy(
  scopeValue: unknown,
  directory: readonly RecommendationCategoryDirectoryItem[],
  input: { productPatternId: number; inputLocale?: string; activeTagIds?: readonly number[] },
): RecommendationCategoryPolicy {
  const scope = record(scopeValue);
  if (!scope || !Number.isInteger(input.productPatternId) || input.productPatternId <= 0) {
    throw new Error("推荐理由类别策略缺少有效的产品形态范围。");
  }
  const inputLocale = String(input.inputLocale || "zh-CN").trim() || "zh-CN";
  const localePatterns = record(scope.localePatternIds);
  const patternIds = numberList(localePatterns?.[inputLocale] ?? scope.patternIds);
  const excludedTags = new Set(numberList(scope.excludeTagIds));
  const hasExcludedTag = (input.activeTagIds ?? []).some((id) => excludedTags.has(id));
  const scopeMatched = scope.enabled !== false
    && !hasExcludedTag
    && (patternIds.length === 0 || patternIds.includes(input.productPatternId));
  const whitelist = numberList(scope.categoryWhitelist);
  const limited = scopeMatched && whitelist.length > 0;
  const selected = limited ? whitelist : directory.map((item) => item.id);
  const byId = new Map(directory.map((item) => [item.id, item.name]));
  const missing = selected.filter((id) => !byId.has(id));
  if (missing.length) throw new Error(`推荐理由类别目录缺少策略 ID：${missing.join("、")}。`);
  const categories = selected.map((id) => byId.get(id)!).filter(Boolean);
  if (categories.length < 3) throw new Error("推荐理由可用类别少于 3 项，无法生成互不重复的推荐理由。");
  return {
    source: "vbk-qconfig",
    inputLocale,
    productPatternId: input.productPatternId,
    limited,
    categoryIds: selected,
    categories,
    fetchedAt: new Date().toISOString(),
  };
}

function parseDirectory(payload: unknown): RecommendationCategoryDirectoryItem[] {
  const rows = record(payload)?.pmRcmdCategories;
  if (!Array.isArray(rows)) throw new Error("推荐理由类别目录回读为空。");
  const result: RecommendationCategoryDirectoryItem[] = [];
  for (const row of rows) {
    const item = record(row);
    const id = Number(item?.pmRcmdCategoryId);
    const name = String(item?.pmRcmdCategoryName ?? "").trim();
    if (Number.isInteger(id) && id > 0 && name) result.push({ id, name });
  }
  if (!result.length) throw new Error("推荐理由类别目录没有有效分类。");
  return result;
}

async function request(page: VbkSessionRequestBrowser, endpoint: string): Promise<VbkSessionRequestResult> {
  return vbkSessionRequest(page, {
    endpoint,
    body: {},
    errorLabel: "读取推荐理由类别策略",
    browserRequestTimeoutMs: 15_000,
    evaluateTimeoutMs: 20_000,
    includeCidQuery: true,
    headers: { cookieorigin: "https://vbooking.ctrip.com" },
    referrer: "https://vbooking.ctrip.com/product/input/",
    referrerPolicy: "strict-origin-when-cross-origin",
  });
}

function assertSuccess(result: VbkSessionRequestResult, label: string): void {
  if (result.status < 200 || result.status >= 300) throw new Error(`${label}读取失败：HTTP ${result.status}。`);
  const ack = String(record(record(result.payload)?.ResponseStatus)?.Ack ?? "").trim();
  if (ack && ack !== "Success") throw new Error(`${label}读取失败：Ack=${ack}。`);
}

function numberList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(Number).filter((item) => Number.isInteger(item) && item > 0))];
}

function record(value: unknown): Json | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : null;
}
