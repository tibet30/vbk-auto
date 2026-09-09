/**
 * itinerary 阶段的 POI 补全与统一核查任务。
 *
 * 查询失败只保留可观察日志；未匹配与自然生成的景点核查使用同一 canonical
 * 标签，实际落库去重由 runtime.addResearchTask 负责。
 */

import { poiResearchTaskLabel } from "../../shared/poi-research-tasks.js";
import { AI_WRITABLE_PATHS } from "./schemas.js";
import type { ResearchTaskProposal } from "../../shared/contracts-planning.js";
import type { OrchestratorRuntime } from "./types.js";
import { logInfo, logWarn } from "../../shared/log-timestamp.js";

interface PoiEnrichmentArgs {
  localProductId: string;
  destination: string;
  runtime: OrchestratorRuntime;
  persistedTaskKeys: Set<string>;
  /** 单景点查询的主进程兜底；默认 16 秒。测试可缩短。 */
  queryTimeoutMs?: number;
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

  if ((runtime.suggestPoi || runtime.resolvePoiSelection) && Array.isArray(product.itinerary)
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
        if (match && spot && typeof spot === "object" && !Array.isArray(spot)) {
          applyPoiMatch(spot, match);
          poiUpdated = true;
          logInfo("[planning.poi]", { event: "query-success", localProductId, keyword, poiName: match.poiName, poiId: match.poiId });
        } else if (match && typeof spot === "string") {
          const index = day.spots.indexOf(spot);
          day.spots[index] = {
            name: spot,
            poiName: match.poiName,
            poiId: match.poiId,
            ...(match.province ? { province: match.province } : {}),
            ...(match.city ? { city: match.city } : {}),
            ...(match.district ? { district: match.district } : {}),
          };
          poiUpdated = true;
          logInfo("[planning.poi]", { event: "query-success", localProductId, keyword, poiName: match.poiName, poiId: match.poiId });
        } else if (!queryFailed) {
          logInfo("[planning.poi]", { event: "query-no-match", localProductId, keyword });
          const task = buildPoiResearchTask(
            String(keyword),
            suspended
              ? "携程景点详情标记为暂停营业，不能加入行程；请替换为正常营业景点"
              : isTravelNodeName(originalKeyword)
              ? "该名称是接送/交通/住宿节点，不能作为行程景点 POI；请替换为可游览景点"
              : "未找到对应的 VBK POI，已保留原景点和原行程位置；请确认景点名称或手动录入 POI",
          );
          const key = `${task.type}::${task.label}`;
          if (!persistedTaskKeys.has(key)) {
            await runtime.addResearchTask(localProductId, task);
            persistedTaskKeys.add(key);
            addedTasks.push(task);
          }
        }
      }
    }
    if (poiUpdated) {
      const writeResult = await runtime.writeModule(localProductId, "itinerary", AI_WRITABLE_PATHS.itinerary, updated);
      if (!writeResult.ok) {
        const reason = writeResult.reason || "本地写入被拒";
        logWarn("[planning.poi]", { event: "write-back-failed", localProductId, reason });
        throw new Error(`POI 映射未保存：${reason}`);
      }
      logInfo("[planning.poi]", { event: "write-back", localProductId });
    }
  }

  return addedTasks;
}

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
    if (args.runtime.resolvePoiSelection) {
      const selected = await rejectPoiQueryAfter(
        args.runtime.resolvePoiSelection(args.localProductId, args.keyword, args.context),
        args.queryTimeoutMs,
      );
      return {
        match: selected.match ? normalisePoiMatch(selected.match) : null,
        failed: false,
        suspended: selected.status === "suspended",
      };
    }
    const candidate = await rejectPoiQueryAfter(args.runtime.suggestPoi!(args.keyword, args.context), args.queryTimeoutMs);
    const availability = candidate ? await queryPoiAvailability(args.runtime, args.localProductId, candidate.poiId) : null;
    return {
      match: availability === "suspended" ? null : normalisePoiMatch(candidate),
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

type PoiMatch = { poiName: string; poiId: number; province?: string; city?: string; district?: string };

function normalisePoiMatch(match: { poiName?: unknown; poiId?: unknown; province?: unknown; city?: unknown; district?: unknown } | null | undefined): PoiMatch | null {
  if (!match || typeof match !== "object") return null;
  const poiName = match.poiName;
  const poiId = match.poiId;
  if (!hasText(poiName) || !isPositiveInteger(poiId)) return null;
  if (isTravelNodeName(poiName)) return null;
  return {
    poiName: poiName.trim(), poiId,
    ...(hasText(match.province) ? { province: match.province.trim() } : {}),
    ...(hasText(match.city) ? { city: match.city.trim() } : {}),
    ...(hasText(match.district) ? { district: match.district.trim() } : {}),
  };
}

function applyPoiMatch(spot: Record<string, unknown>, match: PoiMatch): void {
  spot.poiName = match.poiName;
  spot.poiId = match.poiId;
  if (match.province) spot.province = match.province;
  if (match.city) spot.city = match.city;
  if (match.district) spot.district = match.district;
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
