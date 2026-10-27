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
import { queryPoi, applyPoiMatch, queryPoiAvailability, queryItineraryPoiAvailabilities, isTravelNodeName, backfillItineraryPoiCoordinates } from "./poi-enrichment/query.js";
import { hasDefinitePoiLocationConflict } from "./poi-location-conflict.js";
import { isCompatiblePoiIdentity } from "../../shared/poi-candidate-identity.js";
import { poiResearchFailureDetail } from "../../shared/poi-research-outcome.js";
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
    const deferred: Array<{ day: any; spot: any; keyword: string; poiContext: ReturnType<typeof buildPoiContextForItineraryDay>;
      reviewingComplete: boolean; attempt: Awaited<ReturnType<typeof selectSpotPoi>> }> = [];
    let deferredBaseline = 0;
    const pendingTasks: Array<{ keyword: string; detail: string }> = [];
    // 地域复核前补齐已绑定 POI 的平台坐标，跨城景点才能按路线走廊回读证明。
    let poiUpdated = shouldReviewCompletePois
      && await backfillItineraryPoiCoordinates(runtime, localProductId, updated, queryTimeoutMs);

    for (const day of updated) {
      for (const spot of Array.isArray(day?.spots) ? day.spots : []) {
        const keyword = typeof spot === "string" ? spot : spot?.name ?? spot?.poiName;
        if (!keyword) continue;
        if (!requiresItineraryPoi(spot as Record<string, unknown>)) continue;
        const poiContext = buildPoiContextForItineraryDay(product, args.destination, day, String(keyword));
        let invalidLocation = false;
        let invalidIdentity = false;
        let reviewingComplete = false;
        if (hasCompletePoi(spot as Record<string, unknown>)) {
          if (!shouldReviewCompletePois) continue;
          reviewingComplete = true;
          invalidIdentity = !isCompatiblePoiIdentity(String(keyword), String(spot.poiName));
          const availability = availabilityByPoiId.get(spot.poiId) ?? await queryPoiAvailability(runtime, localProductId, spot.poiId, queryTimeoutMs);
          if (availability === "suspended") {
            const retainedName = String(spot.name || keyword);
            clearPoiBinding(spot);
            poiUpdated = true;
            pendingTasks.push({
              keyword: retainedName,
              detail: "携程景点详情标记为暂停营业，已清除旧 POI 绑定并保留原行程位置；请待恢复营业后重新查询或替换景点",
            });
            logInfo("[planning.poi]", { event: "suspended-poi-cleared", localProductId, keyword: retainedName });
            continue;
          }
          // Re-resolve every reviewed mapping. Definite location contradictions
          // are cleared immediately; an inconclusive lookup retains the old
          // fact but opens a durable current-verification gate below.
          invalidLocation = hasDefinitePoiLocationConflict({
            ...spot,
            index: 0, selectable: true, textFields: [],
          }, poiContext, { ...product, itinerary: updated }, String(keyword));
          if (invalidLocation || invalidIdentity) {
            clearPoiBinding(spot);
            poiUpdated = true;
          }
        }
        const originalKeyword = String(keyword);
        const attempt = await selectSpotPoi({ runtime, localProductId, queryTimeoutMs, itinerary: updated,
          spot, keyword: originalKeyword, poiContext, reviewingComplete, deferLocation: true });
        // 跨城景点靠同轮已绑定的锚点城市景点作路线走廊参考；先绑定其余景点，再补核一次。
        if (!attempt.match && !attempt.queryFailed && !attempt.suspended && attempt.selectionReason === "location_mismatch"
          && !invalidLocation && !invalidIdentity) {
          if (!deferred.length) deferredBaseline = boundPointCount(updated);
          deferred.push({ day, spot, keyword: originalKeyword, poiContext, reviewingComplete, attempt });
          continue;
        }
        const { match, queryFailed, suspended, selectionReason } = attempt;
        if (match && spot && typeof spot === "object" && !Array.isArray(spot)) {
          applyPoiMatch(spot, match);
          poiUpdated = true;
          recordVerifiedMapping(verifiedMappings, runtime, day, originalKeyword, match);
          logInfo("[planning.poi]", { event: "query-success", localProductId, keyword, poiName: match.poiName, poiId: match.poiId });
        } else if (match && typeof spot === "string") {
          const index = day.spots.indexOf(spot);
          day.spots[index] = { name: spot };
          applyPoiMatch(day.spots[index], match);
          poiUpdated = true;
          recordVerifiedMapping(verifiedMappings, runtime, day, originalKeyword, match);
          logInfo("[planning.poi]", { event: "query-success", localProductId, keyword, poiName: match.poiName, poiId: match.poiId });
        } else if (!queryFailed || invalidLocation || reviewingComplete) {
          if (suspended && spot && typeof spot === "object" && !Array.isArray(spot)) {
            clearPoiBinding(spot);
            poiUpdated = true;
          }
          logInfo("[planning.poi]", { event: "query-no-match", localProductId, keyword });
          const detail = poiResearchFailureDetail({
            reason: selectionReason,
            reviewingComplete,
            queryFailed,
            invalidLocation,
            invalidIdentity,
            suspended,
            travelNode: isTravelNodeName(originalKeyword),
          });
          pendingTasks.push({
            keyword: String(keyword), detail,
          });
        }
      }
    }
    // 补核轮走完整查询（原名 + 别名 + 复核时的官方名回查）。首轮跳过的别名/官方名
    // 查询不依赖走廊参考，必须照常执行；只有原名查询在没有新增参考时可沿用首轮结论。
    const referencesAdded = deferred.length > 0 && boundPointCount(updated) > deferredBaseline;
    for (const item of deferred) {
      const { day, spot, keyword, poiContext, reviewingComplete } = item;
      const { match, queryFailed, suspended, selectionReason } = await selectSpotPoi({ runtime, localProductId, queryTimeoutMs,
        itinerary: updated, spot, keyword, poiContext, reviewingComplete, firstAttempt: referencesAdded ? undefined : item.attempt });
      if (match) {
        if (typeof spot === "string") {
          const index = day.spots.indexOf(spot);
          day.spots[index] = { name: spot };
          applyPoiMatch(day.spots[index], match);
        } else applyPoiMatch(spot, match);
        poiUpdated = true;
        recordVerifiedMapping(verifiedMappings, runtime, day, keyword, match);
        logInfo("[planning.poi]", { event: "query-success-after-references", localProductId, keyword, poiName: match.poiName, poiId: match.poiId });
        continue;
      }
      // 与首轮一致：非复核景点查询失败时不建任务，留给下次重试。
      if (queryFailed && !reviewingComplete) continue;
      logInfo("[planning.poi]", { event: "query-no-match", localProductId, keyword });
      pendingTasks.push({ keyword,
        detail: poiResearchFailureDetail({ reason: selectionReason, reviewingComplete, queryFailed, invalidLocation: false,
          invalidIdentity: false, suspended, travelNode: isTravelNodeName(keyword) }) });
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
    // 任务在行程落库后才写入：重开判断要读到本轮清除/改绑后的产品，否则旧绑定
    // 仍能对上旧凭证，被清除绑定的已确认任务不会重新打开。
    for (const task of pendingTasks) {
      await addPoiResearchTask({ runtime, localProductId, persistedTaskKeys, addedTasks, ...task });
    }
  }

  return addedTasks;
}

/** 一次受控 POI 选择：原名、同地点别名，复核时再用已绑定官方名回查同一 poiId。 */
async function selectSpotPoi(args: {
  runtime: OrchestratorRuntime; localProductId: string; queryTimeoutMs: number; itinerary: unknown[];
  spot: any; keyword: string; poiContext: ReturnType<typeof buildPoiContextForItineraryDay>; reviewingComplete: boolean;
  /** 首轮：原名地点未证实时直接返回，待同轮锚点景点绑定后再补核。 */
  deferLocation?: boolean;
  /** 补核轮在没有新增走廊参考时复用首轮原名查询结果，不重复同一请求。 */
  firstAttempt?: { match: Awaited<ReturnType<typeof queryPoi>>["match"]; queryFailed: boolean; suspended: boolean;
    selectionReason: Awaited<ReturnType<typeof queryPoi>>["reason"] };
}) {
  const { runtime, localProductId, queryTimeoutMs, itinerary: updated, spot, reviewingComplete, poiContext } = args;
  const originalKeyword = args.keyword;
    const firstQuery = args.firstAttempt
      ? { match: args.firstAttempt.match, failed: args.firstAttempt.queryFailed, suspended: args.firstAttempt.suspended, reason: args.firstAttempt.selectionReason }
      : isTravelNodeName(originalKeyword)
      ? { match: null, failed: false, suspended: false, reason: undefined }
      : await queryPoi({ runtime, localProductId, keyword: originalKeyword, queryTimeoutMs, context: poiContext, itinerary: updated });
    let match = firstQuery.match;
    let queryFailed = firstQuery.failed;
    let suspended = firstQuery.suspended;
    let selectionReason = firstQuery.reason;
    // “永祚寺（双塔寺）”这类官方名+同地点别名先做确定性别名查询，
    // 避免整串关键词召回外地同名前缀，也避免模型原样重复后耗尽重试。
    // 原名已召回同名候选、只是地点未证实时，换别名查不到新证据：交给补核轮。
    if (!match && !queryFailed && !suspended && !(args.deferLocation && selectionReason === "location_mismatch")) {
      for (const alias of queryAliases(originalKeyword)) {
        if (isTravelNodeName(alias)) continue;
        const aliasQuery = await queryPoi({ runtime, localProductId, keyword: alias, queryTimeoutMs, context: poiContext, itinerary: updated });
        match = aliasQuery.match;
        queryFailed = aliasQuery.failed;
        suspended = aliasQuery.suspended;
        selectionReason = aliasQuery.reason;
        if (match || queryFailed || suspended) break;
      }
    }
    // 复核已绑定 POI 时，用户的原始叫法常常只是俗称（「船观神女峰」→
    // 「神女峰」），用俗称重查永远无法复现唯一候选，会把已经核验成功的
    // 绑定反复重开成待处理事项。这里用已绑定的官方 poiName 再走一次同
    // 一条受控核验；只有回到同一个 poiId 才算复核通过，换 ID 一律按原
    // 失败流程阻塞，不能借官方名洗白历史错配。
    if (!match && !queryFailed && !suspended && reviewingComplete
      && !(args.deferLocation && selectionReason === "location_mismatch")
      && spot && typeof spot === "object" && !Array.isArray(spot)) {
      const officialName = textValue(spot.poiName);
      const boundPoiId = Number(spot.poiId);
      if (officialName && officialName !== originalKeyword && !isTravelNodeName(officialName)
        && Number.isInteger(boundPoiId) && boundPoiId > 0) {
        // 选择器会优先使用 context.spotName 做身份匹配，必须把它改成官方名，
        // 否则平台用官方名查询、本地却仍按原始俗称判定，等于没回查。
        const officialContext = { ...poiContext, spotName: officialName };
        const officialQuery = await queryPoi({ runtime, localProductId, keyword: officialName, queryTimeoutMs, context: officialContext, itinerary: updated });
        if (officialQuery.match?.poiId === boundPoiId) {
          match = officialQuery.match;
          selectionReason = officialQuery.reason;
          logInfo("[planning.poi]", { event: "review-official-name-confirmed", localProductId, keyword: originalKeyword, poiName: officialName, poiId: boundPoiId });
        }
      }
    }
  return { match, queryFailed, suspended, selectionReason };
}

/** 带平台坐标的已绑定景点数，用于判断补核轮是否有新的走廊参考。 */
function boundPointCount(itinerary: any[]): number {
  return itinerary.flatMap((day) => Array.isArray(day?.spots) ? day.spots : [])
    .filter((spot) => spot && typeof spot === "object" && hasCompletePoi(spot)
      && Number.isFinite(spot.latitude) && Number.isFinite(spot.longitude)).length;
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
  if (/淞/u.test(value)) aliases.push(value.replace(/淞/gu, "凇"));
  else if (/凇/u.test(value)) aliases.push(value.replace(/凇/gu, "淞"));
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
  delete spot.latitude;
  delete spot.longitude;
}

function textValue(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
