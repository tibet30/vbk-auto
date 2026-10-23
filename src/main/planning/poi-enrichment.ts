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
import { hasCompletePoi, requiresItineraryPoi } from "../../shared/itinerary-activity-kind.js";
import { buildPoiContextForItineraryDay } from "./poi-context.js";
import { queryPoi, applyPoiMatch, queryPoiAvailability, queryItineraryPoiAvailabilities, isTravelNodeName } from "./poi-enrichment/query.js";
import { isPlanningPoiCandidateInContext } from "./poi-auto-selection.js";
import type { VerifiedPoiMapping } from "./types.js";

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
    && (day as { spots: unknown[] }).spots.some((spot) => requiresItineraryPoi(spot as Record<string, unknown>) && !hasCompletePoi(spot as Record<string, unknown>)));
}

export async function enrichItineraryPois(args: PoiEnrichmentArgs): Promise<ResearchTaskProposal[]> {
  const { localProductId, runtime, persistedTaskKeys } = args;
  const queryTimeoutMs = timeoutOrDefault(args.queryTimeoutMs, POI_ENRICHMENT_QUERY_TIMEOUT_MS);
  const product = await runtime.loadCurrentProduct(localProductId);
  const shouldReviewCompletePois = args.reviewCompletePois === true && hasProductPoiContext(product);
  const addedTasks: ResearchTaskProposal[] = [];
  const verifiedMappings: VerifiedPoiMapping[] = [];

  if ((runtime.suggestPoi || runtime.resolvePoiSelection) && Array.isArray(product.itinerary)
    && (hasIncompleteItineraryPois(product) || (shouldReviewCompletePois && hasCompleteItineraryPois(product)))) {
    const updated = structuredClone(product.itinerary) as any[];
    const availabilityByPoiId = await queryItineraryPoiAvailabilities(runtime, localProductId, updated, shouldReviewCompletePois, queryTimeoutMs);
    let poiUpdated = false;
    for (const day of updated) {
      const poiContext = buildPoiContextForItineraryDay(product, args.destination, day);
      for (const spot of Array.isArray(day?.spots) ? day.spots : []) {
        const keyword = typeof spot === "string" ? spot : spot?.name ?? spot?.poiName;
        if (!keyword) continue;
        if (!requiresItineraryPoi(spot as Record<string, unknown>)) continue;
        let invalidLocation = false;
        let reviewingComplete = false;
        if (hasCompletePoi(spot as Record<string, unknown>)) {
          if (!shouldReviewCompletePois) continue;
          reviewingComplete = true;
          const availability = availabilityByPoiId.get(spot.poiId) ?? await queryPoiAvailability(runtime, localProductId, spot.poiId, queryTimeoutMs);
          if (availability === "suspended") {
            const retainedName = String(spot.name || keyword);
            clearPoiBinding(spot);
            poiUpdated = true;
            await addPoiResearchTask({
              runtime, localProductId, persistedTaskKeys, addedTasks,
              keyword: retainedName,
              detail: "携程景点详情标记为暂停营业，已清除旧 POI 绑定并保留原行程位置；请待恢复营业后重新查询或替换景点",
            });
            logInfo("[planning.poi]", { event: "suspended-poi-cleared", localProductId, keyword: retainedName });
            continue;
          }
          // Re-resolve every reviewed mapping. Definite location contradictions
          // are cleared immediately; an inconclusive lookup retains the old
          // fact but opens a durable current-verification gate below.
          const hasKnownLocation = Boolean(spot.city || spot.province);
          invalidLocation = hasKnownLocation && !isPlanningPoiCandidateInContext({
            ...spot,
            province: spot.province || poiContext.province,
            city: spot.city || poiContext.destinationCity,
            index: 0, selectable: true, textFields: [],
          }, poiContext, product, String(keyword));
          if (invalidLocation) {
            clearPoiBinding(spot);
            poiUpdated = true;
          }
        }
        const originalKeyword = String(keyword);
        const firstQuery = isTravelNodeName(originalKeyword)
          ? { match: null, failed: false, suspended: false }
          : await queryPoi({ runtime, localProductId, keyword: originalKeyword, queryTimeoutMs, context: poiContext });
        let match = firstQuery.match;
        let queryFailed = firstQuery.failed;
        let suspended = firstQuery.suspended;
        let selectionReason = firstQuery.reason;
        // “永祚寺（双塔寺）”这类官方名+同地点别名先做确定性别名查询，
        // 避免整串关键词召回外地同名前缀，也避免模型原样重复后耗尽重试。
        if (!match && !queryFailed && !suspended) {
          for (const alias of queryAliases(originalKeyword)) {
            if (isTravelNodeName(alias)) continue;
            const aliasQuery = await queryPoi({ runtime, localProductId, keyword: alias, queryTimeoutMs, context: poiContext });
            match = aliasQuery.match;
            queryFailed = aliasQuery.failed;
            suspended = aliasQuery.suspended;
            selectionReason = aliasQuery.reason;
            if (match || queryFailed || suspended) break;
          }
        }
        if (match && spot && typeof spot === "object" && !Array.isArray(spot)) {
          applyPoiMatch(spot, match);
          poiUpdated = true;
          recordVerifiedMapping(verifiedMappings, runtime, day, originalKeyword, match);
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
          recordVerifiedMapping(verifiedMappings, runtime, day, originalKeyword, match);
          logInfo("[planning.poi]", { event: "query-success", localProductId, keyword, poiName: match.poiName, poiId: match.poiId });
        } else if (!queryFailed || invalidLocation || reviewingComplete) {
          if (suspended && spot && typeof spot === "object" && !Array.isArray(spot)) {
            clearPoiBinding(spot);
            poiUpdated = true;
          }
          logInfo("[planning.poi]", { event: "query-no-match", localProductId, keyword });
          const retainedForCurrentReview = reviewingComplete && !invalidLocation && !suspended;
          const detail = retainedForCurrentReview && queryFailed
            ? "本轮 POI 核验未完成：平台查询失败或超时，已保留先前绑定；请重新查询并确认当前 POI"
            : retainedForCurrentReview && selectionReason === "ambiguous"
            ? "本轮 POI 核验未完成：当前查询召回多个候选，无法安全确定唯一地点，已保留先前绑定；请重新查询或手动选择 POI"
            : retainedForCurrentReview && selectionReason === "location_mismatch"
            ? "本轮 POI 核验未完成：候选地域信息不足或与当前行程上下文不一致，已保留先前绑定；请重新查询并确认当前 POI"
            : retainedForCurrentReview
            ? "本轮 POI 核验未完成：当前查询未召回可确认候选，已保留先前绑定；请重新查询或手动确认当前 POI"
            : suspended
            ? "携程景点详情标记为暂停营业，不能加入行程；请替换为正常营业景点"
            : isTravelNodeName(originalKeyword)
            ? "该名称是接送/交通/住宿节点，不能作为行程景点 POI；请替换为可游览景点"
            : selectionReason === "location_mismatch"
            ? "已找到候选 POI，但其地域与产品主城市不一致；请确认当天行程地点范围或手动绑定 POI"
            : selectionReason === "ambiguous"
            ? "已找到多个候选 POI，但程序无法安全确定唯一地点；请手动选择 POI"
            : "未找到对应的 VBK POI，已保留原景点和原行程位置；请确认景点名称或手动录入 POI";
          await addPoiResearchTask({
            runtime, localProductId, persistedTaskKeys, addedTasks,
            keyword: String(keyword), detail,
          });
        }
      }
    }
    if (poiUpdated) {
      const writeResult = runtime.writeResolvedItineraryPois
        ? await runtime.writeResolvedItineraryPois(localProductId, updated, product.itinerary as unknown[], verifiedMappings)
        : await runtime.writeModule(localProductId, "itinerary", AI_WRITABLE_PATHS.itinerary, updated);
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

function recordVerifiedMapping(
  mappings: VerifiedPoiMapping[],
  runtime: OrchestratorRuntime,
  day: Record<string, unknown>,
  spotName: string,
  match: { poiName: string; poiId: number; province?: string; city?: string; district?: string },
): void {
  // Only the production controlled selector proves candidate context,
  // availability and confidence. A bare suggestPoi result cannot settle a
  // durable operator-selection gate.
  if (!runtime.resolvePoiSelection) return;
  const dayNumber = Number(day.day);
  if (!Number.isInteger(dayNumber) || dayNumber <= 0) return;
  mappings.push({ day: dayNumber, spotName, ...match });
}

function bracketAliases(value: string): string[] {
  const aliases = Array.from(value.matchAll(/[（(]([^）)]+)[）)]/g), (match) => match[1].trim());
  return [...new Set(aliases.filter((alias) => alias && alias !== value.trim()))];
}

function queryAliases(value: string): string[] {
  const aliases = bracketAliases(value);
  if (/措$/u.test(value)) aliases.push(value.replace(/措$/u, "错"));
  else if (/错$/u.test(value)) aliases.push(value.replace(/错$/u, "措"));
  return [...new Set(aliases.filter((alias) => alias && alias !== value.trim()))];
}

function hasProductPoiContext(product: Record<string, unknown>): boolean {
  const basic = product.basicInfo && typeof product.basicInfo === "object" && !Array.isArray(product.basicInfo)
    ? product.basicInfo as Record<string, unknown>
    : {};
  return Boolean(textValue(basic.destinationCity) || textValue(basic.meetingCity) || textValue(basic.province));
}
function hasCompleteItineraryPois(product: Record<string, unknown>): boolean {
  if (!Array.isArray(product.itinerary)) return false;
  return product.itinerary.some((day) => Array.isArray((day as { spots?: unknown }).spots)
    && (day as { spots: unknown[] }).spots.some((spot) => requiresItineraryPoi(spot as Record<string, unknown>) && hasCompletePoi(spot as Record<string, unknown>)));
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
function timeoutOrDefault(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : fallback;
}

function clearPoiBinding(spot: Record<string, unknown>): void {
  spot.poiName = null;
  spot.poiId = null;
  delete spot.province;
  delete spot.city;
  delete spot.district;
}

function textValue(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
