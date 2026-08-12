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
  projectId: string;
  destination: string;
  runtime: OrchestratorRuntime;
  persistedTaskKeys: Set<string>;
  /** 单景点查询的主进程兜底；默认 16 秒。测试可缩短。 */
  queryTimeoutMs?: number;
  /** 可选的模型候选名解析器；未配置时保留原来的直接人工核查语义。 */
  resolvePoiName?: (request: PoiNameResolutionRequest) => Promise<string | null>;
}

export const POI_ENRICHMENT_QUERY_TIMEOUT_MS = 16_000;

/** 已有 itinerary 在续跑前是否仍有需要补全的 POI。 */
export function hasIncompleteItineraryPois(product: Record<string, unknown>): boolean {
  if (!Array.isArray(product.itinerary)) return false;
  return product.itinerary.some((day) => Array.isArray((day as { spots?: unknown }).spots)
    && (day as { spots: unknown[] }).spots.some((spot) => !isPoiComplete(spot)));
}

export async function enrichItineraryPois(args: PoiEnrichmentArgs): Promise<ResearchTaskProposal[]> {
  const { projectId, runtime, persistedTaskKeys } = args;
  const queryTimeoutMs = timeoutOrDefault(args.queryTimeoutMs, POI_ENRICHMENT_QUERY_TIMEOUT_MS);
  const product = await runtime.loadCurrentProduct(projectId);
  const addedTasks: ResearchTaskProposal[] = [];

  if (runtime.suggestPoi && Array.isArray(product.itinerary) && hasIncompleteItineraryPois(product)) {
    const updated = structuredClone(product.itinerary) as any[];
    let poiUpdated = false;
    for (const day of updated) {
      for (const spot of Array.isArray(day?.spots) ? day.spots : []) {
        if (isPoiComplete(spot)) continue;
        const keyword = typeof spot === "string" ? spot : spot?.name ?? spot?.poiName;
        if (!keyword) continue;
        const firstQuery = await queryPoi({ runtime, projectId, keyword: String(keyword), queryTimeoutMs });
        let match = firstQuery.match;
        let queryFailed = firstQuery.failed;
        let fallbackAttempts = 0;
        if (!match && !queryFailed && args.resolvePoiName) {
          const fallback = await resolveFallbackPoi({
            runtime,
            resolver: args.resolvePoiName,
            originalName: String(keyword),
            destination: args.destination,
            projectId,
            queryTimeoutMs,
          });
          match = fallback.match;
          queryFailed = fallback.queryFailed;
          fallbackAttempts = fallback.attempts;
        }
        if (match && typeof spot === "object") {
          spot.poiName = match.poiName;
          spot.poiId = match.poiId;
          poiUpdated = true;
          logInfo("[planning.poi]", { event: "query-success", projectId, keyword, poiName: match.poiName, poiId: match.poiId });
        } else if (match && typeof spot === "string") {
          const index = day.spots.indexOf(spot);
          day.spots[index] = { name: spot, poiName: match.poiName, poiId: match.poiId };
          poiUpdated = true;
          logInfo("[planning.poi]", { event: "query-success", projectId, keyword, poiName: match.poiName, poiId: match.poiId });
        } else if (!queryFailed) {
          logInfo("[planning.poi]", { event: "query-no-match", projectId, keyword });
          const task: ResearchTaskProposal = {
            label: poiResearchTaskLabel(String(keyword)),
            type: "vbk",
            detail: fallbackAttempts > 0
              ? `suggestPoi 未匹配，已进行 ${fallbackAttempts} 次 AI 名称纠正仍未匹配，请人工核查`
              : "suggestPoi 未匹配，请人工核查",
          };
          const key = `${task.type}::${task.label}`;
          // `addResearchTask` 对同一 canonical 标签采用更新详情的语义。AI
          // 三次纠正耗尽后，即便任务已存在，也要升级为可操作的最终说明；
          // 但返回值仍只报告本轮新建的任务。
          if (fallbackAttempts > 0) {
            await runtime.addResearchTask(projectId, task);
            if (!persistedTaskKeys.has(key)) {
              persistedTaskKeys.add(key);
              addedTasks.push(task);
            }
          } else if (!persistedTaskKeys.has(key)) {
            await runtime.addResearchTask(projectId, task);
            persistedTaskKeys.add(key);
            addedTasks.push(task);
          }
        }
      }
    }
    if (poiUpdated) {
      await runtime.writeModule(projectId, "itinerary", AI_WRITABLE_PATHS.itinerary, updated);
      logInfo("[planning.poi]", { event: "write-back", projectId });
    }
  }

  return addedTasks;
}

const MAX_AI_POI_NAME_ATTEMPTS = 3;

async function queryPoi(args: {
  runtime: OrchestratorRuntime;
  projectId: string;
  keyword: string;
  queryTimeoutMs: number;
}): Promise<{ match: { poiName: string; poiId: number } | null; failed: boolean }> {
  try {
    logInfo("[planning.poi]", { event: "query-start", projectId: args.projectId, keyword: args.keyword });
    const match = await rejectPoiQueryAfter(args.runtime.suggestPoi!(args.keyword), args.queryTimeoutMs);
    return { match, failed: false };
  } catch (error) {
    logWarn("[planning.poi]", {
      event: "query-failed",
      projectId: args.projectId,
      keyword: args.keyword,
      error: error instanceof Error ? error.message : String(error),
    });
    return { match: null, failed: true };
  }
}

async function resolveFallbackPoi(args: {
  runtime: OrchestratorRuntime;
  resolver: (request: PoiNameResolutionRequest) => Promise<string | null>;
  originalName: string;
  destination: string;
  projectId: string;
  queryTimeoutMs: number;
}): Promise<{ match: { poiName: string; poiId: number } | null; queryFailed: boolean; attempts: number }> {
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
      logWarn("[planning.poi]", { event: "fallback-resolver-failed", projectId: args.projectId, originalName: args.originalName, attempt, error: error instanceof Error ? error.message : String(error) });
    }
    if (!isUsableFallbackCandidate(candidate, args.originalName, previousCandidates)) {
      logInfo("[planning.poi]", { event: "fallback-candidate-rejected", projectId: args.projectId, originalName: args.originalName, attempt });
      continue;
    }
    logInfo("[planning.poi]", { event: "fallback-query-start", projectId: args.projectId, originalName: args.originalName, candidate, attempt });
    previousCandidates.push(candidate);
    const result = await queryPoi({ runtime: args.runtime, projectId: args.projectId, keyword: candidate, queryTimeoutMs: args.queryTimeoutMs });
    if (result.failed) return { match: null, queryFailed: true, attempts: attempt };
    if (result.match) return { match: result.match, queryFailed: false, attempts: attempt };
  }
  return { match: null, queryFailed: false, attempts: MAX_AI_POI_NAME_ATTEMPTS };
}

function isUsableFallbackCandidate(candidate: string | null, originalName: string, previousCandidates: readonly string[]): candidate is string {
  const value = candidate?.trim();
  if (!value || value === originalName.trim() || previousCandidates.includes(value)) return false;
  // 中点、斜杠、顿号和常见并列连接词都表明模型仍在给组合点，而
  // suggestPoi 兜底只能接受一个可验证实体，不能把多个候选混作一次查询。
  return !/[·、/]/.test(value) && !/[及和与暨]/.test(value);
}

function isPoiComplete(spot: unknown): boolean {
  if (!spot || typeof spot !== "object") return false;
  const candidate = spot as { poiName?: unknown; poiId?: unknown };
  return hasText(candidate.poiName) && isPositiveInteger(candidate.poiId);
}

function hasText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
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
