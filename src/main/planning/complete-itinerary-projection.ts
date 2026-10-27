import type { ProductDetail } from "../../shared/contracts.js";
import type { PlanningStageOutput } from "../../shared/contracts-planning.js";
import { extractLockedConstraints, isPlanningControlMessage } from "../agent/prompt-helpers.js";
import { classifyItineraryInputMode, explicitAlternativeGroups, itineraryInputContractError } from "./itinerary-input-contract.js";
import { itineraryStructureError } from "./itinerary-structure.js";
import { projectDatedRoute } from "./dated-route-projection.js";
import { selfRepairItineraryForVbk } from "./itinerary-self-repair.js";
import { daySection, daySections } from "./day-sections.js";
import {
  boundaryAnchors,
  isBoundaryAnchor,
  isRouteArrivalNode,
  projectedSpotKind,
  routeHeads,
  splitProjectedSpots,
} from "./itinerary-spot-projection.js";
import { parseProductBriefMessage } from '../../shared/product-brief-message.js';
import { isPersistedRouteTravelNode } from '../../shared/itinerary-route-travel-node.js';
import { isItineraryTransferName } from '../../shared/itinerary-transfer-name.js';
import { normaliseItinerarySupport, supportArrangementType } from '../../shared/itinerary-support-arrangements.js';
import { isProductAdministrativeRouteName } from '../../shared/product-administrative-route-name.js';
import { toPlatformShortLocationName } from '../../shared/location-short-name.js';
import { constraintUserIdea } from "../../shared/product-idea-optimization.js";

type JsonObject = Record<string, unknown>;
type LockedDay = { day: number; spots: string[]; unorderedSpots?: string[] };

/**
 * Complete, day-by-day customer routes are source data, not a prompt for a
 * second itinerary design.  When no usable itinerary exists yet, project that
 * source data into the ordinary itinerary module so the usual schema, write,
 * readback and POI-resolution gates still run.
 */
export function projectCompleteItinerary(product: ProductDetail): PlanningStageOutput | undefined {
  const currentItinerary = product.product.itinerary;
  const replayOriginal = requestsOriginalRouteReplay(userMessages(product).at(-1)?.content ?? '');
  if (!replayOriginal && !itineraryStructureError(product.product as JsonObject)
    && !itineraryInputContractError(product, currentItinerary)) return undefined;
  const basic = record(product.product.basicInfo);
  const days = positiveInteger(basic?.days);
  if (!days) return undefined;
  if (hasUnmergedRequirement(product)) return undefined;

  const locked = extractLockedConstraints(product, userMessages(product));
  if (classifyItineraryInputMode(locked, days, product.planning?.userIntent) !== "complete") return undefined;
  const order = reliableCompleteOrder(locked.itineraryOrder, days);
  if (!order) return undefined;
  const dated = projectDatedRoute(product);
  if (dated && !itineraryStructureError({ ...product.product, itinerary: dated }) && !itineraryInputContractError(product, dated)) {
    return { reply: "已保留完整原路线、各日终点及括号观星安排，生成待核验行程。",
      modules: [{ module: "itinerary", status: "proposed", value: dated }] };
  }
  const alternativeGroups = explicitAlternativeGroups(product);
  const expandedOrder = expandAlternativeGroups(order, alternativeGroups);
  if (!expandedOrder || expandedOrder.some((row) => row.spots.every(isTravelService))) return undefined;
  const heads = routeHeads(originalDaySections(product));
  const anchors = boundaryAnchors(expandedOrder, heads);
  const projected = expandedOrder.map((row) => projectDay({
    row,
    product: product.product as JsonObject,
    days,
    nights: positiveInteger(basic?.nights) ?? 0,
    fallbackStay: text(basic?.meetingCity) || text(basic?.destinationCity),
    rawDayText: rawDayText(product, row.day),
    alternativeGroups,
    anchors: anchors.get(row.day) ?? new Set<string>(),
  }));
  const itinerary = selfRepairItineraryForVbk(projected.map(normaliseItinerarySupport), positiveInteger(basic?.nights) ?? 0,
    product.product as JsonObject).itinerary;
  if (itineraryStructureError({ ...product.product, itinerary }) || itineraryInputContractError(product, itinerary)) return undefined;
  return {
    reply: "已按用户完整逐日行程生成待核验草案，保留原日序、景点顺序和二选一关系。",
    modules: [{ module: "itinerary", status: "proposed", value: itinerary }],
  };
}

function projectDay(args: {
  row: LockedDay;
  product: JsonObject;
  days: number;
  nights: number;
  fallbackStay: string;
  rawDayText: string;
  alternativeGroups: Array<{ day: number; names: string[] }>;
  anchors: ReadonlySet<string>;
}): JsonObject {
  const travelServices = serviceNotes(args.rawDayText, args.row.spots);
  const routeNames = [...args.row.spots, ...(args.row.unorderedSpots ?? [])];
  // 行政落脚点（「重庆万州」）、接送/住宿服务名（「返程」「万州送站」）与
  // 相邻天共享的起终点（「延吉」「哈尔滨」）没有可绑定 POI，不能投影成景点。
  const placeNames = routeNames.filter((name) => !isTravelService(name)
    && !isProductAdministrativeRouteName(args.product, name)
    && supportArrangementType({ name }) === undefined
    && !isItineraryTransferName(name)
    && !isRouteArrivalNode(name)
    && !isBoundaryAnchor(name, args.anchors));
  // `长白山北景区&天池` 是一个复合路线节点，不是单个 POI；拆开后才可核验。
  const entries = [...new Map(placeNames.flatMap((sourceName) => splitProjectedSpots(sourceName)
    .map((name) => [name.replace(/\s+/gu, ""), { name, sourceName }] as const))).values()];
  const groups = args.alternativeGroups.filter((group) => group.day === args.row.day);
  const candidates = entries.map((entry) => entry.name);
  const title = formatAttractionSequence(candidates, groups, " · ") || placeNames.join(" · ") || args.rawDayText.trim();
  const routeDay = { day: args.row.day, title };
  const departures = candidates.filter(name => isPersistedRouteTravelNode(args.product, routeDay, name));
  const kept = entries.filter((entry) => !departures.includes(entry.name));
  const attractions = kept.map((entry) => entry.name);
  const description = formatAttractionSequence(attractions, groups, "、");
  const sourceNotes = parentheticalNotes(args.rawDayText);
  const spots = kept.map((entry, index) => ({
    name: entry.name,
    kind: projectedSpotKind(entry.name),
    poiName: null,
    poiId: null,
    timeOfDay: timeFor(index, kept.length, groups, entry.name),
    relation: groups.some((group) => group.names.some((candidate) =>
      samePlace(candidate, entry.name) || samePlace(candidate, entry.sourceName))) ? "or" : "and",
  }));
  const stay = stayForDay(args);
  const stayCity = stay ? writableStayCity(stay, args.rawDayText) : undefined;
  const overnight = args.row.day <= args.nights;
  return {
    day: args.row.day,
    title,
    spots,
    description: [
      ...(attractions.length ? [`按用户原定顺序安排：${description}。`]
        : [`当日为行政落脚与接送安排，无可绑定 POI 的景点：${placeNames.join("、") || args.rawDayText.trim()}。`]),
      ...(sourceNotes.length ? [`原始补充：${sourceNotes.join("、")}。`] : []),
      ...travelServices,
      `原始逐日安排：${args.rawDayText.trim()}。`,
      overnight ? stay ? `当晚按原路线住${stay}，使用平台自动匹配酒店。`
        : "当晚沿原路线安排平台酒店，住宿行政城市待资源核验。" : "当日返程，不安排住宿。",
    ].join(""),
    hotel: overnight ? stay ? `${stay}（待匹配）` : "使用携程平台酒店，自动匹配三钻、四钻、五钻酒店" : "无",
    ...(stayCity ? { hotelCity: stayCity } : {}),
    meals: "自理",
    ...(departures.length || travelServices.length || !attractions.length
      || attractions.every(name => toPlatformShortLocationName(name) === args.fallbackStay)
      ? { activities: [{ time: '不限', type: 'transport', title: args.rawDayText.trim(), detail: args.rawDayText.trim() }] }
      : {}),
  };
}

function reliableCompleteOrder(value: unknown, days: number): LockedDay[] | undefined {
  if (!Array.isArray(value) || value.length !== days) return undefined;
  const byDay = new Map<number, LockedDay>();
  for (const row of value) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return undefined;
    const item = row as JsonObject;
    const day = positiveInteger(item.day);
    const rawSpots = item.spots;
    const spots = Array.isArray(rawSpots) ? rawSpots.map(text).filter(Boolean) : [];
    const rawUnorderedSpots = item.unorderedSpots;
    const unorderedSpots = Array.isArray(rawUnorderedSpots) ? rawUnorderedSpots.map(text).filter(Boolean) : [];
    if (!day || !spots.length || byDay.has(day)) return undefined;
    byDay.set(day, { day, spots, ...(unorderedSpots.length ? { unorderedSpots } : {}) });
  }
  const order = Array.from({ length: days }, (_, index) => byDay.get(index + 1));
  return order.every(Boolean) ? order as LockedDay[] : undefined;
}

function expandAlternativeGroups(order: LockedDay[], groups: Array<{ day: number; names: string[] }>): LockedDay[] | undefined {
  const expanded: LockedDay[] = [];
  for (const row of order) {
    const dayGroups = groups.filter((group) => group.day === row.day);
    if (dayGroups.some((group) => {
      const indexes = row.spots.map((name, index) => group.names.some((candidate) => samePlace(candidate, name)) ? index : -1)
        .filter((index) => index >= 0);
      return indexes.length > 1 && indexes.some((index, position) => position > 0 && index !== indexes[position - 1]! + 1);
    })) return undefined;
    const emitted = new Set<string>();
    const spots = row.spots.flatMap((name) => {
      const group = dayGroups.find((item) => item.names.some((candidate) => samePlace(candidate, name)));
      if (!group) return [name];
      const key = group.names.map((item) => item.replace(/\s+/g, "")).join("|");
      if (emitted.has(key)) return [];
      emitted.add(key);
      return group.names;
    });
    expanded.push({ ...row, spots });
  }
  return expanded;
}

function stayForDay(args: { row: LockedDay; nights: number; fallbackStay: string; rawDayText: string }): string | undefined {
  if (args.row.day > args.nights) return undefined;
  const parenthesized = args.rawDayText.match(/[（(]\s*宿\s*([^）)]+)[）)]/u)?.[1]?.trim();
  const explicit = parenthesized
    || args.rawDayText.match(/(?:住宿|入住|住(?!宿))\s*(?:为|：|:)?\s*([^—–\-，,、。；;\n（(→]{2,30})/u)?.[1]?.trim();
  const endpoint = args.row.spots.at(-1);
  const generic = /^(?:(?:市区|当地|平台|精品|舒适|特色)?(?:酒店|宾馆|民宿|客栈)|住宿)$/u;
  return (explicit && !generic.test(explicit) ? explicit : undefined) || (endpoint && toPlatformShortLocationName(endpoint) === args.fallbackStay ? args.fallbackStay : undefined);
}

/**
 * 投影出的住宿落点直接补上 hotelCity，避免下游按酒店文案猜城市时丢掉跨城
 * 住宿城市（「云阳」「奉节」没有市县尾缀，解析器无法从占位文案还原）。
 * 「住巫山或者万州」在本地只落第一个明确城市，原始二选一仍保留在描述与
 * 原始逐日安排里，由运营在确认前决定。
 */
function writableStayCity(stay: string, rawDayText: string): string | undefined {
  const first = stay.split(/(?:或者|或|\/|／)/u)[0]?.trim()
    .replace(/(?:温泉)?(?:酒店|宾馆|民宿|客栈|住宿)$/u, "")
    .replace(/(?:附近|周边|当地)$/u, "") ?? "";
  const city = toPlatformShortLocationName(first);
  if (!city || !rawDayText.includes(first)) return undefined;
  if (/(?:镇|村|乡|景区|风景区|片区|园区|街区|社区|古城|古镇)$/u.test(city)) return undefined;
  return city;
}

function parentheticalNotes(raw: string): string[] {
  return [...raw.matchAll(/[（(]([^）)]+)[）)]/gu)]
    .map((match) => match[1]?.trim() ?? "")
    .filter((note) => note.length > 0 && !/^宿\s*/u.test(note) && note !== "二选一");
}

function originalDaySections(product: ProductDetail): ReturnType<typeof daySections> {
  const sources = [constraintUserIdea(product.product.basicInfo),
    ...userMessages(product).map((message) => messagePlainText(message.content))].filter(Boolean);
  const merged = new Map<number, ReturnType<typeof daySections>[number]>();
  for (const source of sources) for (const section of daySections(source)) merged.set(section.day, section);
  return [...merged.values()].sort((left, right) => left.day - right.day);
}

function rawDayText(product: ProductDetail, day: number): string {
  const sections = [constraintUserIdea(product.product.basicInfo), ...userMessages(product).map((message) => messagePlainText(message.content))]
    .map((value) => daySection(value, day))
    .map((value) => value.replace(/^[:：、，,\s]+/u, "").trim())
    .filter(Boolean);
  // A later day-specific correction replaces that day's old operational text.
  // Combining them can preserve two contradictory accommodation instructions.
  return sections.at(-1) ?? "";
}

/** A later user requirement can alter an option, lodging, or a named POI. Do
 * not combine it heuristically with the first brief; the model path has the
 * full correction contract and is the conservative fallback. */
function hasUnmergedRequirement(product: ProductDetail): boolean {
  const original = text(record(product.product.basicInfo)?.userIdea);
  return userMessages(product).some((message) => !messageRestatesOriginalBrief(message.content, original)
    && !requestsOriginalRouteReplay(message.content)
    && !isPlanningControlMessage(message.content));
}

function requestsOriginalRouteReplay(content: string): boolean {
  const value = content.replace(/\s+/gu, "");
  return /(?:从头)?重新(?:规划|生成|执行)/u.test(value)
    && /(?:原始|原定)(?:完整)?(?:逐日)?(?:行程|路线|方案)/u.test(value)
    && !/(?:改为|修改|替换|新增|删除|移除|取消|不再)/u.test(value);
}

function messageRestatesOriginalBrief(content: string, original: string): boolean {
  if (content.trim() === original) return true;
  try {
    const parsed = JSON.parse(content) as unknown;
    return record(parsed)?.type === "product_brief" && text(record(parsed)?.userIdea) === original;
  } catch {
    return false;
  }
}

function serviceNotes(raw: string, spots: string[]): string[] {
  const notes: string[] = [];
  if (/(?:接火车|火车站接|接站)/u.test(raw) || spots.some((name) => /(?:接火车|火车站接|接站)/u.test(name))) notes.push("含火车站接站服务。");
  if (/(?:送火车|送站)/u.test(raw) || spots.some((name) => /(?:送火车|送站)/u.test(name))) notes.push("含火车站送站服务。");
  const namedServices = raw.split(/[-—–→，,。；;\n]/u).map(value => value.trim())
    .filter(value => /^[\p{Script=Han}]{2,10}(?:接站|送站|接机|送机|接团|送团)$/u.test(value));
  if (namedServices.length) notes.push(`保留原始接送地点：${namedServices.join('、')}。`);
  if (/(?:接机|送机|接团|送团|集合|解散)/u.test(raw)) notes.push(`接送与集合安排按原文执行：${raw.trim()}。`);
  return notes;
}

/** Format active OR groups as one customer-facing choice while leaving the
 * underlying spots, order and relation markers untouched. */
function formatAttractionSequence(
  attractions: readonly string[],
  groups: ReadonlyArray<{ names: string[] }>,
  separator: string,
): string {
  const emitted = new Set<number>();
  return attractions.flatMap((name) => {
    const groupIndex = groups.findIndex((group) => group.names.some((candidate) => samePlace(candidate, name)));
    if (groupIndex < 0) return [name];
    if (emitted.has(groupIndex)) return [];
    emitted.add(groupIndex);
    const choices = attractions.filter((candidate) => groups[groupIndex]!.names.some((item) => samePlace(item, candidate)));
    return [`${choices.join("或")}（二选一）`];
  }).join(separator);
}

function isTravelService(name: string): boolean {
  return isItineraryTransferName(name);
}

function timeFor(index: number, length: number, groups: Array<{ names: string[] }>, name: string): "morning" | "afternoon" {
  const group = groups.find((item) => item.names.some((candidate) => samePlace(candidate, name)));
  if (group) {
    const first = group.names.findIndex((candidate) => samePlace(candidate, name));
    const firstIndex = first < 0 ? index : Math.max(0, index - first);
    return firstIndex < Math.ceil(length / 2) ? "morning" : "afternoon";
  }
  return index < Math.ceil(length / 2) ? "morning" : "afternoon";
}

/** 创建产品的 product_brief 消息是 JSON 副本；逐日切分必须用其中的 userIdea。 */
function messagePlainText(content: string): string {
  return parseProductBriefMessage(content)?.userIdea?.trim() || content;
}

function userMessages(product: ProductDetail): Array<{ role: string; content: string }> {
  return (product.messages ?? []).filter((message) => message.role === "user").map((message) => ({ role: "user", content: message.content }));
}

function record(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function positiveInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}
function samePlace(left: string, right: string): boolean {
  const a = left.replace(/\s+/g, "");
  const b = right.replace(/\s+/g, "");
  return Boolean(a) && Boolean(b) && (a === b || a.includes(b) || b.includes(a));
}
