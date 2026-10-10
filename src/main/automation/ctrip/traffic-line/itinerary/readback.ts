/**
 * traffic-line/itinerary.ts（readback 子模块）：
 *   readTrafficNodesFromPage：从子产品行程页（TourDays）拉首末日 traffic 节点；
 *   isTrafficNode：activeType.key 与 expectedKey 一致，或通过 name 兜底（航班 / 火车）；
 *   isCompleteTrafficNode：在 isTrafficNode 基础上进一步要求包含 flight / train 卡片。
 */

import { getVbkInitialState, list, record, text, type JsonRecord, type TrafficLinePage } from "../client.js";
import { expectedTrafficKey } from "./traffic-merge.js";
import { hasFlightCard, hasTrainCard, hasNamedCode } from "./predicates.js";
import type { TrafficLineVariant } from "../../../../../shared/contracts-traffic-line.js";

/**
 * 从子产品行程页（TourDays）拉首末日 traffic 节点。
 * 失败 → 抛错提示"需先核对资源段提交结果"。
 */
export async function readTrafficNodesFromPage(page: TrafficLinePage, productId: string, variant: TrafficLineVariant): Promise<{ first: JsonRecord; last: JsonRecord }> {
  const endpoint = `https://vbooking.ctrip.com/ivbk/vendor/TourDays?productid=${encodeURIComponent(productId)}&istab=1&from=vbk`;
  const state = await getVbkInitialState(page, endpoint, "子产品行程页");
  const context = record(state.dailyContext) ?? state;
  const days = list(context.tourDailyDescriptions);
  const expected = expectedTrafficKey(variant);
  const first = list(days[0]?.tourDailyInfos).find((node) => isTrafficNode(node, expected));
  const last = list(days.at(-1)?.tourDailyInfos).find((node) => isTrafficNode(node, expected));
  if (!first || !last) throw new Error(`子产品 ${productId} 行程页未返回可用的首末日交通节点，需先核对资源段提交结果。`);
  return { first, last };
}

/** activeType.key 与 expectedKey 一致，或通过 name 兜底（航班 / 火车）。 */
export function isTrafficNode(node: JsonRecord, expectedKey: number): boolean {
  const activeType = record(node.activeType);
  return Number(activeType?.key) === expectedKey
    || (expectedKey === 2 && /航班|飞机/.test(text(activeType?.name)))
    || (expectedKey === 14 && /火车|高铁/.test(text(activeType?.name)));
}

/** 在 isTrafficNode 基础上进一步要求包含 flight / train 卡片。 */
export function isCompleteTrafficNode(node: JsonRecord, expectedKey: number): boolean {
  if (!isTrafficNode(node, expectedKey)) return false;
  if (expectedKey === 2) return hasFlightCard(node);
  if (expectedKey === 14) return hasTrainCard(node);
  return true;
  void hasNamedCode; // 用于 trafficNodeWithRequiredCard 内同名复用，不在本函数调用
}