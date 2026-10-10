/**
 * traffic-line/itinerary.ts（traffic-merge 子模块）：
 *   头/尾节点合并 / 校验 / 兜底替换：
 *   - mergeTrafficNodes：把 firstTransport / lastTransport 合并到 days[0] 与 days.at(-1)
 *     的 tourDailyInfos 中，按 variant 决定 firstNode / lastNode 并替换不完整节点；
 *   - verifyTrafficNodes：节点数 vs 期望天数，缺则抛错；
 *   - describeEdgeDays（私有）：把"首末日节点是否完整"写成短句，便于错误信息；
 *   - expectedTrafficKey：flightRoundTrip=2（航班 key），其他=14（火车 key）；
 *   - replaceIncompleteEdgeTraffic（私有）：把首尾不完整节点从 infos 数组里剔除，
 *     并在 start / end 位置补一个完整节点。
 *
 * 测试切片：traffic-line-empty-train-card / traffic-line-populated-flight-card 等
 * 会直接调用 mergeTrafficNodes + verifyTrafficNodes；本文件保留原签名。
 */

import { list, record, text, type JsonRecord } from "../client.js";
import type { TrafficLineEndpointPlan, TrafficLineVariant } from "../../../../../shared/contracts-traffic-line.js";
import { finaliseTrafficNode, trafficNodeWithRequiredCard } from "./card-builders.js";
import { isCompleteTrafficNode, isTrafficNode } from "./readback.js";

/**
 * 把首末交通节点合并到子产品行程 days[0] / days.at(-1) 的 tourDailyInfos：
 *   - 先 clone 原 tourInfo；
 *   - days 为空 → 抛错；
 *   - 末日与首日同（singleDay）时 only one day，所有交通写入同一 day；
 *   - 用 finaliseTrafficNode 给每个 info 补 sort（enter / leave + index + 1）。
 */
export function mergeTrafficNodes(
  tourInfo: JsonRecord,
  firstTransport: JsonRecord,
  lastTransport: JsonRecord,
  variant: TrafficLineVariant,
  endpoints?: TrafficLineEndpointPlan,
): JsonRecord {
  const result = structuredClone(tourInfo);
  const days = list(result.tourDailyDescriptions);
  if (!days.length) throw new Error("子产品行程没有任何天数，无法插入交通节点。");
  const singleDay = days.length === 1;
  const first = structuredClone(days[0]!);
  const last = structuredClone(days.at(-1)!);
  const firstInfos = list(first.tourDailyInfos);
  const lastInfos = singleDay ? firstInfos : list(last.tourDailyInfos);
  const expected = expectedTrafficKey(variant);
  const firstNode = trafficNodeWithRequiredCard(firstTransport, variant, "enter", endpoints);
  const lastNode = trafficNodeWithRequiredCard(lastTransport, variant, "leave", endpoints);
  replaceIncompleteEdgeTraffic(firstInfos, firstNode, expected, 1, "start");
  replaceIncompleteEdgeTraffic(lastInfos, lastNode, expected, singleDay ? 2 : 1, "end");
  first.tourDailyInfos = firstInfos.map((node, index) => finaliseTrafficNode(node, variant, "enter", index + 1, endpoints));
  if (singleDay) {
    days[0] = first;
  } else {
    last.tourDailyInfos = lastInfos.map((node, index) => finaliseTrafficNode(node, variant, "leave", index + 1, endpoints));
    days[0] = first; days[days.length - 1] = last;
  }
  result.tourDailyDescriptions = days;
  return result;
}

/** 校验节点数 vs 期望天数，缺则抛错；返回总完整交通节点数。 */
export function verifyTrafficNodes(tourInfo: JsonRecord, variant: TrafficLineVariant): number {
  const days = list(tourInfo.tourDailyDescriptions);
  if (!days.length) throw new Error("子产品行程交通回读没有任何天数。");
  const expected = expectedTrafficKey(variant);
  const firstCount = list(days[0]?.tourDailyInfos).filter((node) => isCompleteTrafficNode(node, expected)).length;
  const lastCount = list(days.at(-1)?.tourDailyInfos).filter((node) => isCompleteTrafficNode(node, expected)).length;
  const required = days.length === 1 ? 2 : 1;
  if (firstCount < 1 || lastCount < required) {
    throw new Error(`子产品行程交通回读缺少首日或末日目标交通节点（${describeEdgeDays(tourInfo, expected)}）。`);
  }
  return days.reduce((sum, day) => sum + list(day.tourDailyInfos).filter((node) => isCompleteTrafficNode(node, expected)).length, 0);
}

/** 首末边界日的节点清单诊断：节点是否还在、交通节点是否缺车次/航班卡片。 */
function describeEdgeDays(tourInfo: JsonRecord, expected: number): string {
  const days = list(tourInfo.tourDailyDescriptions);
  if (!days.length) return "行程没有任何天数";
  const singleDay = days.length === 1;
  const edgeDays = singleDay ? [days[0]!] : [days[0]!, days.at(-1)!];
  const labels = singleDay ? ["唯一日"] : ["首日", "末日"];
  return edgeDays.map((day, index) => {
    const nodes = list(day?.tourDailyInfos).map((node) => {
      const activeType = record(node.activeType);
      const name = text(activeType?.name) || `key=${text(activeType?.key) || "?"}`;
      if (isCompleteTrafficNode(node, expected)) return `${name}✓`;
      if (isTrafficNode(node, expected)) return `${name}(缺车次/航班卡片)`;
      return name;
    });
    return `${labels[index]}[${nodes.join("、") || "无节点"}]`;
  }).join("；");
}

/** flightRoundTrip → 2（航班 activeType.key），其它 → 14（火车）。 */
export function expectedTrafficKey(variant: TrafficLineVariant): number {
  return variant === "flightRoundTrip" ? 2 : 14;
}

/** 把首尾不完整节点剔除并按 start / end 位置补一个完整节点。 */
function replaceIncompleteEdgeTraffic(
  infos: JsonRecord[],
  sourceNode: JsonRecord,
  expected: number,
  requiredCount: number,
  insert: "start" | "end",
): void {
  const kept = infos.filter((node) => !isTrafficNode(node, expected) || isCompleteTrafficNode(node, expected));
  infos.splice(0, infos.length, ...kept);
  if (infos.filter((node) => isCompleteTrafficNode(node, expected)).length >= requiredCount) return;
  if (insert === "start") infos.unshift(sourceNode);
  else infos.push(sourceNode);
}