/**
 * itinerary 阶段的 POI 补全与统一核查任务。
 *
 * 查询失败只保留可观察日志；未匹配与自然生成的景点核查使用同一 canonical
 * 标签，实际落库去重由 runtime.addResearchTask 负责。
 */

import { poiResearchTaskLabel } from "../../shared/poi-research-tasks.js";
import { AI_WRITABLE_PATHS } from "./schemas.js";
import type { PoiNameResolutionRequest, ResearchTaskProposal } from "../../shared/contracts-planning.js";
import type { OrchestratorRuntime } from "./types.js";
import { logInfo, logWarn } from "../../shared/log-timestamp.js";

interface PoiEnrichmentArgs {
  localProductId: string;
  destination: string;
  runtime: OrchestratorRuntime;
  persistedTaskKeys: Set<string>;
  /** 单景点查询的主进程兜底；默认 16 秒。测试可缩短。 */
  queryTimeoutMs?: number;
  /** 可选的模型候选名解析器；未配置时保留原来的直接人工核查语义。 */
  resolvePoiName?: (request: PoiNameResolutionRequest) => Promise<string | null>;
  /** 复核已存在的完整 POI，用于修复历史同名错配；默认只补缺失 POI。 */
  reviewCompletePois?: boolean;
}

export const POI_ENRICHMENT_QUERY_TIMEOUT_MS = 16_000;

/** 已有 itinerary 在续跑前是否仍有需要补全的 POI。 */
export function hasIncompleteItineraryPois(product: Record<string, unknown>): boolean {
  if (!Array.isArray(product.itinerary)) return false;
  return product.itinerary.some((day) => Array.isArray((day as { spots?: unknown }).spots)
    && (day as { spots: unknown[] }).spots.some((spot) => !isPoiComplete(spot)));
}

export async function enrichItineraryPois(args: PoiEnrichmentArgs): Promise<ResearchTaskProposal[]> {
  const { localProductId, runtime, persistedTaskKeys } = args;
  const queryTimeoutMs = timeoutOrDefault(args.queryTimeoutMs, POI_ENRICHMENT_QUERY_TIMEOUT_MS);
  const product = await runtime.loadCurrentProduct(localProductId);
  const poiContext = buildPoiContext(product, args.destination);
  const shouldReviewCompletePois = args.reviewCompletePois === true && hasProductPoiContext(product);
  const addedTasks: ResearchTaskProposal[] = [];

  if (runtime.suggestPoi && Array.isArray(product.itinerary)
    && (hasIncompleteItineraryPois(product) || (shouldReviewCompletePois && hasCompleteItineraryPois(product)))) {
    const updated = structuredClone(product.itinerary) as any[];
    const availabilityByPoiId = await queryItineraryPoiAvailabilities(runtime, localProductId, updated, shouldReviewCompletePois);
    let poiUpdated = false;
    for (const day of updated) {
      for (const spot of Array.isArray(day?.spots) ? day.spots : []) {
        const keyword = typeof spot === "string" ? spot : spot?.name ?? spot?.poiName;
        if (!keyword) continue;
        if (isPoiComplete(spot)) {
          if (!shouldReviewCompletePois) continue;
          const availability = availabilityByPoiId.get(spot.poiId) ?? await queryPoiAvailability(runtime, localProductId, spot.poiId);
          if (availability === "suspended") {
            const removedName = String(spot.poiName || keyword);
            day.spots.splice(day.spots.indexOf(spot), 1);
            poiUpdated = true;
            await addPoiResearchTask({
              runtime, localProductId, persistedTaskKeys, addedTasks,
              keyword: removedName,
              detail: "携程景点详情标记为暂停营业，已从行程移除；请替换为正常营业景点",
            });
            logInfo("[planning.poi]", { event: "suspended-poi-removed", localProductId, keyword: removedName });
            continue;
          }
          const checked = await queryPoi({ runtime, localProductId, keyword: String(spot.poiName || keyword), queryTimeoutMs, context: poiContext });
          if (checked.failed) continue;
          if (checked.match && checked.match.poiId === spot.poiId && checked.match.poiName === spot.poiName) continue;
          if (checked.match) {
            spot.poiName = checked.match.poiName;
            spot.poiId = checked.match.poiId;
            poiUpdated = true;
            logInfo("[planning.poi]", { event: "context-replacement-success", localProductId, keyword, poiName: checked.match.poiName, poiId: checked.match.poiId });
            continue;
          }
          spot.poiName = null;
          spot.poiId = null;
          poiUpdated = true;
          const task = buildPoiResearchTask(String(keyword), "已填 POI 未通过目的地/省份复核，请人工核查或替换为同城可用景点");
          const key = `${task.type}::${task.label}`;
          if (!persistedTaskKeys.has(key)) {
            await runtime.addResearchTask(localProductId, task);
            persistedTaskKeys.add(key);
            addedTasks.push(task);
          }
          continue;
        }
        const originalKeyword = String(keyword);
        const firstQuery = isTravelNodeName(originalKeyword)
          ? { match: null, failed: false, suspended: false }
          : await queryPoi({ runtime, localProductId, keyword: originalKeyword, queryTimeoutMs, context: poiContext });
        let match = firstQuery.match;
        let queryFailed = firstQuery.failed;
        let suspended = firstQuery.suspended;
        let fallbackAttempts = 0;
        // “永祚寺（双塔寺）”这类官方名+同地点别名先做确定性别名查询，
        // 避免整串关键词召回外地同名前缀，也避免模型原样重复后耗尽重试。
        if (!match && !queryFailed && !suspended) {
          for (const alias of bracketAliases(originalKeyword)) {
            if (isTravelNodeName(alias)) continue;
            const aliasQuery = await queryPoi({ runtime, localProductId, keyword: alias, queryTimeoutMs, context: poiContext });
            match = aliasQuery.match;
            queryFailed = aliasQuery.failed;
            suspended = aliasQuery.suspended;
            if (match || queryFailed || suspended) break;
          }
        }
        if (!match && !queryFailed && !suspended && args.resolvePoiName) {
          const fallback = await resolveFallbackPoi({
            runtime,
            resolver: args.resolvePoiName,
            originalName: originalKeyword,
            destination: args.destination,
            localProductId,
            queryTimeoutMs,
            context: poiContext,
          });
          match = fallback.match;
          queryFailed = fallback.queryFailed;
          suspended = fallback.suspended;
          fallbackAttempts = fallback.attempts;
        }
        if (match && typeof spot === "object") {
          spot.poiName = match.poiName;
          spot.poiId = match.poiId;
          poiUpdated = true;
          if (match.source === "fallback") spot.name = match.poiName;
          logInfo("[planning.poi]", { event: match.source === "fallback" ? "replacement-success" : "query-success", localProductId, keyword, poiName: match.poiName, poiId: match.poiId });
        } else if (match && typeof spot === "string") {
          const index = day.spots.indexOf(spot);
          day.spots[index] = { name: match.source === "fallback" ? match.poiName : spot, poiName: match.poiName, poiId: match.poiId };
          poiUpdated = true;
          logInfo("[planning.poi]", { event: match.source === "fallback" ? "replacement-success" : "query-success", localProductId, keyword, poiName: match.poiName, poiId: match.poiId });
        } else if (!queryFailed) {
          logInfo("[planning.poi]", { event: "query-no-match", localProductId, keyword });
          const task = buildPoiResearchTask(
            String(keyword),
            suspended
              ? "携程景点详情标记为暂停营业，不能加入行程；请替换为正常营业景点"
              : isTravelNodeName(originalKeyword)
              ? "该名称是接送/交通/住宿节点，不能作为行程景点 POI；请替换为可游览景点"
              : fallbackAttempts > 0
              ? `suggestPoi 未匹配，已进行 ${fallbackAttempts} 次 AI 名称纠正仍未匹配，请人工核查`
              : "suggestPoi 未匹配，请人工核查",
          );
          const key = `${task.type}::${task.label}`;
          // `addResearchTask` 对同一 canonical 标签采用更新详情的语义。AI
          // 三次纠正耗尽后，即便任务已存在，也要升级为可操作的最终说明；
          // 但返回值仍只报告本轮新建的任务。
          if (fallbackAttempts > 0) {
            await runtime.addResearchTask(localProductId, task);
            if (!persistedTaskKeys.has(key)) {
              persistedTaskKeys.add(key);
              addedTasks.push(task);
            }
          } else if (!persistedTaskKeys.has(key)) {
            await runtime.addResearchTask(localProductId, task);
            persistedTaskKeys.add(key);
            addedTasks.push(task);
          }
        }
      }
    }
    if (poiUpdated) {
      await runtime.writeModule(localProductId, "itinerary", AI_WRITABLE_PATHS.itinerary, updated);
      logInfo("[planning.poi]", { event: "write-back", localProductId });
    }
  }

  return addedTasks;
}

const MAX_AI_POI_NAME_ATTEMPTS = 3;

function bracketAliases(value: string): string[] {
  const aliases = Array.from(value.matchAll(/[（(]([^）)]+)[）)]/g), (match) => match[1].trim());
  return [...new Set(aliases.filter((alias) => alias && alias !== value.trim()))];
}

async function queryPoi(args: {
  runtime: OrchestratorRuntime;
  localProductId: string;
  keyword: string;
  queryTimeoutMs: number;
  context?: { destinationCity?: string; province?: string };
}): Promise<{ match: PoiMatch | null; failed: boolean; suspended: boolean }> {
  try {
    logInfo("[planning.poi]", { event: "query-start", localProductId: args.localProductId, keyword: args.keyword });
    const candidate = await rejectPoiQueryAfter(args.runtime.suggestPoi!(args.keyword, args.context), args.queryTimeoutMs);
    const availability = candidate ? await queryPoiAvailability(args.runtime, args.localProductId, candidate.poiId) : null;
    return {
      match: availability === "suspended" ? null : normalisePoiMatch(candidate, "direct"),
      failed: availability === "unverified",
      suspended: availability === "suspended",
    };
  } catch (error) {
    logWarn("[planning.poi]", {
      event: "query-failed",
      localProductId: args.localProductId,
      keyword: args.keyword,
      error: error instanceof Error ? error.message : String(error),
    });
    return { match: null, failed: true, suspended: false };
  }
}

async function resolveFallbackPoi(args: {
  runtime: OrchestratorRuntime;
  resolver: (request: PoiNameResolutionRequest) => Promise<string | null>;
  originalName: string;
  destination: string;
  localProductId: string;
  queryTimeoutMs: number;
  context?: { destinationCity?: string; province?: string };
}): Promise<{ match: PoiMatch | null; queryFailed: boolean; suspended: boolean; attempts: number }> {
  const previousCandidates: string[] = [];
  for (let attempt = 1; attempt <= MAX_AI_POI_NAME_ATTEMPTS; attempt += 1) {
    let candidate: string | null = null;
    try {
      candidate = await args.resolver({
        originalName: args.originalName,
        destination: args.destination,
        attempt,
        previousCandidates,
      });
    } catch (error) {
      logWarn("[planning.poi]", { event: "fallback-resolver-failed", localProductId: args.localProductId, originalName: args.originalName, attempt, error: error instanceof Error ? error.message : String(error) });
    }
    if (!isUsableFallbackCandidate(candidate, args.originalName, previousCandidates)) {
      logInfo("[planning.poi]", { event: "fallback-candidate-rejected", localProductId: args.localProductId, originalName: args.originalName, attempt });
      continue;
    }
    logInfo("[planning.poi]", { event: "fallback-query-start", localProductId: args.localProductId, originalName: args.originalName, candidate, attempt });
    previousCandidates.push(candidate);
    const result = await queryPoi({
      runtime: args.runtime,
      localProductId: args.localProductId,
      keyword: candidate,
      queryTimeoutMs: args.queryTimeoutMs,
      context: args.context,
    });
    if (result.failed) return { match: null, queryFailed: true, suspended: false, attempts: attempt };
    if (result.suspended) return { match: null, queryFailed: false, suspended: true, attempts: attempt };
    if (result.match) return { match: { ...result.match, source: "fallback" }, queryFailed: false, suspended: false, attempts: attempt };
  }
  return { match: null, queryFailed: false, suspended: false, attempts: MAX_AI_POI_NAME_ATTEMPTS };
}

function isUsableFallbackCandidate(candidate: string | null, originalName: string, previousCandidates: readonly string[]): candidate is string {
  const value = candidate?.trim();
  if (!value || value === originalName.trim() || previousCandidates.includes(value)) return false;
  if (isTravelNodeName(value)) return false;
  // 中点、斜杠、顿号和常见并列连接词都表明模型仍在给组合点，而
  // suggestPoi 兜底只能接受一个可验证实体，不能把多个候选混作一次查询。
  return !/[·、/]/.test(value) && !/[及和与暨]/.test(value);
}

function buildPoiContext(product: Record<string, unknown>, destination: string): { destinationCity?: string; province?: string } {
  const basic = product.basicInfo && typeof product.basicInfo === "object" && !Array.isArray(product.basicInfo)
    ? product.basicInfo as Record<string, unknown>
    : {};
  return {
    destinationCity: textValue(basic.destinationCity) || textValue(basic.meetingCity) || destination,
    province: textValue(basic.province) || destination,
  };
}

function hasProductPoiContext(product: Record<string, unknown>): boolean {
  const basic = product.basicInfo && typeof product.basicInfo === "object" && !Array.isArray(product.basicInfo)
    ? product.basicInfo as Record<string, unknown>
    : {};
  return Boolean(textValue(basic.destinationCity) || textValue(basic.meetingCity) || textValue(basic.province));
}

type PoiMatch = { poiName: string; poiId: number; source: "direct" | "fallback" };

function normalisePoiMatch(match: { poiName?: unknown; poiId?: unknown } | null | undefined, source: PoiMatch["source"]): PoiMatch | null {
  if (!match || typeof match !== "object") return null;
  const poiName = match.poiName;
  const poiId = match.poiId;
  if (!hasText(poiName) || !isPositiveInteger(poiId)) return null;
  if (isTravelNodeName(poiName)) return null;
  return { poiName: poiName.trim(), poiId, source };
}

async function queryPoiAvailability(runtime: OrchestratorRuntime, localProductId: string, poiId: unknown): Promise<"available" | "suspended" | "unverified" | null> {
  if (!runtime.getPoiAvailability || !isPositiveInteger(poiId)) return null;
  try {
    return (await runtime.getPoiAvailability(poiId)).status;
  } catch (error) {
    logWarn("[planning.poi]", {
      event: "availability-query-failed",
      localProductId,
      poiId,
      error: error instanceof Error ? error.message : String(error),
    });
    return "unverified";
  }
}

async function queryItineraryPoiAvailabilities(
  runtime: OrchestratorRuntime,
  localProductId: string,
  itinerary: any[],
  shouldReviewCompletePois: boolean,
): Promise<Map<number, "available" | "suspended">> {
  if (!shouldReviewCompletePois || !runtime.getPoiAvailabilities) return new Map();
  const poiIds = itinerary.flatMap((day) => Array.isArray(day?.spots) ? day.spots : [])
    .filter(isPoiComplete)
    .map((spot) => spot.poiId as number);
  if (poiIds.length === 0) return new Map();
  try {
    const result = await runtime.getPoiAvailabilities(poiIds);
    return new Map([...result.entries()].map(([poiId, value]) => [poiId, value.status]));
  } catch (error) {
    logWarn("[planning.poi]", {
      event: "availability-batch-query-failed",
      localProductId,
      poiCount: new Set(poiIds).size,
      error: error instanceof Error ? error.message : String(error),
    });
    return new Map();
  }
}

function isTravelNodeName(value: string): boolean {
  return /(机场|航站楼|火车站|高铁站|动车站|汽车站|客运站|码头|酒店|宾馆|民宿|客栈|集合点|接送点|接机点|送机点|接站点|送站点)/.test(value.trim());
}

function isPoiComplete(spot: unknown): boolean {
  if (!spot || typeof spot !== "object") return false;
  const candidate = spot as { poiName?: unknown; poiId?: unknown };
  return hasText(candidate.poiName) && isPositiveInteger(candidate.poiId);
}

function hasCompleteItineraryPois(product: Record<string, unknown>): boolean {
  if (!Array.isArray(product.itinerary)) return false;
  return product.itinerary.some((day) => Array.isArray((day as { spots?: unknown }).spots)
    && (day as { spots: unknown[] }).spots.some((spot) => isPoiComplete(spot)));
}

function buildPoiResearchTask(keyword: string, detail: string): ResearchTaskProposal {
  return {
    label: poiResearchTaskLabel(keyword),
    type: "vbk",
    detail,
  };
}

async function addPoiResearchTask(args: {
  runtime: OrchestratorRuntime;
  localProductId: string;
  persistedTaskKeys: Set<string>;
  addedTasks: ResearchTaskProposal[];
  keyword: string;
  detail: string;
}): Promise<void> {
  const task = buildPoiResearchTask(args.keyword, args.detail);
  const key = `${task.type}::${task.label}`;
  await args.runtime.addResearchTask(args.localProductId, task);
  if (!args.persistedTaskKeys.has(key)) {
    args.persistedTaskKeys.add(key);
    args.addedTasks.push(task);
  }
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function timeoutOrDefault(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : fallback;
}

function rejectPoiQueryAfter<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`VBK POI 查询超时（${timeoutMs}ms）`)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}
