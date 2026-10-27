/**
 * 完整原路线投影到 itinerary 前的纯函数工具：
 *   - routeHeads：从 `【第N天 A—B—C】` 天头提取首尾路线锚点；
 *   - boundaryAnchors：只把相邻天共享的起终点识别为路线锚点；
 *   - splitProjectedSpots：把 `A&B&C` 拆成独立景点，避免整串查 POI；
 *   - projectedSpotKind：体验/服务/泛称落为 other，不再产生 POI 核查项。
 *
 * 所有判断只读取运营原文与日序，不读取生成标题、酒店或已绑定 POI。
 */
import type { DaySection } from "./day-sections.js";
import { isIndependentItineraryExperience } from "../../shared/independent-itinerary-experience.js";
import { isItineraryActivityPhrase } from "../../shared/itinerary-activity-phrase.js";

export interface ProjectionRouteDay {
  day: number;
  spots: string[];
  unorderedSpots?: string[];
}
export interface RouteHead {
  first: string;
  last: string;
}

const NON_ANCHOR_SUFFIX = /(?:景区|风景区|公园|博物馆|纪念馆|寺|庙|宫|塔|楼|阁|湖|山|峰|瀑布|森林|草原|湿地|峡谷|洞|泉|古城|古镇|城|村|街|巷|桥|陵|遗址|广场|市集|山庄|度假区|滑雪场|漂流|温泉)$/u;
const ARRIVAL_PREFIX = /^(?:抵达|到达|前往|返回|赴)\s*/u;

export function routeHeads(sections: readonly DaySection[]): Map<number, RouteHead> {
  const heads = new Map<number, RouteHead>();
  for (const section of sections) {
    const tokens = section.head.split(/[—–\-→]/u).map((token) => token.trim()).filter((token) => token.length >= 2);
    if (tokens.length) heads.set(section.day, { first: tokens[0]!, last: tokens.at(-1)! });
  }
  return heads;
}

/** 只有相邻天共享的起终点才进入锚点集合；单个天头末尾的景点摘要不会被误删。 */
export function boundaryAnchors(
  order: readonly ProjectionRouteDay[],
  heads: ReadonlyMap<number, RouteHead>,
): Map<number, Set<string>> {
  const anchors = new Map<number, Set<string>>();
  const add = (day: number, name: string | undefined) => {
    const key = anchorKey(name);
    if (!key || isLikelyAttractionAnchor(name!)) return;
    const set = anchors.get(day) ?? new Set<string>();
    set.add(key);
    anchors.set(day, set);
  };
  order.forEach((row, index) => {
    const previous = order[index - 1];
    const next = order[index + 1];
    const head = heads.get(row.day);
    const previousBoundaries = [previous?.spots.at(-1), previous ? heads.get(previous.day)?.last : undefined];
    const nextBoundaries = [next?.spots[0], next ? heads.get(next.day)?.first : undefined];
    const previousMatch = previousBoundaries.find((candidate) => sameAnchor(row.spots[0], candidate));
    if (previousMatch) {
      add(row.day, row.spots[0]);
      add(previous!.day, previousMatch);
    }
    const nextMatch = nextBoundaries.find((candidate) => sameAnchor(row.spots.at(-1), candidate));
    if (nextMatch) {
      add(row.day, row.spots.at(-1));
      add(next!.day, nextMatch);
    }
    if (head?.first && previousBoundaries.some((candidate) => sameAnchor(head.first, candidate))) add(row.day, head.first);
    if (head?.last && nextBoundaries.some((candidate) => sameAnchor(head.last, candidate))) add(row.day, head.last);
  });
  return anchors;
}

export function isBoundaryAnchor(name: string, anchors: ReadonlySet<string> | undefined): boolean {
  const key = anchorKey(name);
  return Boolean(key && anchors?.has(key));
}

export function splitProjectedSpots(name: string): string[] {
  return [...new Map(name.split(/[&＆]/u).map((part) => part.trim()).filter((part) => part.length >= 2)
    .map((part) => [part.replace(/\s+/gu, ""), part])).values()];
}

export function projectedSpotKind(name: string): "attraction" | "free" | "other" {
  if (isIndependentItineraryExperience(name) || isItineraryActivityPhrase(name)) return "other";
  if (/^(?:上午|下午|晚上|全天)?\s*自由活动$/u.test(name)) return "free";
  return "attraction";
}

export function isRouteArrivalNode(name: string): boolean {
  return ARRIVAL_PREFIX.test(name.trim());
}

export function anchorKey(value: string | undefined): string {
  if (!value) return "";
  let key = value.trim().replace(/[（(][^）)]*[）)]/gu, "")
    .replace(/^[\s:：、，,。；;【】\[\]（）()]+|[\s:：、，,。；;【】\[\]（）()]+$/gu, "");
  key = key.replace(ARRIVAL_PREFIX, "");
  key = key.replace(/^(?:入住|住宿于|住在|住(?!宿))/u, "");
  key = key.replace(/^宿(?!州|迁|松)/u, "");
  key = key.replace(/(?:集合|接团|送团|接机|送机|接站|送站|接送|返程)$/u, "");
  key = key.replace(/\d{1,2}[:：]\d{2}(?:送站|送机|接站|接机)?$/u, "");
  key = key.replace(/(?:温泉)?(?:酒店|宾馆|民宿|客栈|住宿)$/u, "");
  key = key.replace(/\s+/gu, "");
  return key.length >= 2 ? key : "";
}

function sameAnchor(left: string | undefined, right: string | undefined): boolean {
  const a = anchorKey(left);
  const b = anchorKey(right);
  return Boolean(a && b && a === b);
}

export function isLikelyAttractionAnchor(name: string): boolean {
  return NON_ANCHOR_SUFFIX.test(name.trim());
}
