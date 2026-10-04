import type { ProductDetail } from "../../shared/contracts.js";
import type { PlanningStageOutput } from "../../shared/contracts-planning.js";
import { extractLockedConstraints, isPlanningControlMessage } from "../agent/prompt-helpers.js";
import { classifyItineraryInputMode, explicitAlternativeGroups, itineraryInputContractError } from "./itinerary-input-contract.js";
import { itineraryStructureError } from "./itinerary-structure.js";

type JsonObject = Record<string, unknown>;
type LockedDay = { day: number; spots: string[] };
const DAY_TOKEN: Record<string, number> = {
  "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9, "10": 10,
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

/**
 * Complete, day-by-day customer routes are source data, not a prompt for a
 * second itinerary design.  When no usable itinerary exists yet, project that
 * source data into the ordinary itinerary module so the usual schema, write,
 * readback and POI-resolution gates still run.
 */
export function projectCompleteItinerary(product: ProductDetail): PlanningStageOutput | undefined {
  if (!itineraryStructureError(product.product as JsonObject)) return undefined;
  const basic = record(product.product.basicInfo);
  const days = positiveInteger(basic?.days);
  if (!days) return undefined;
  if (hasUnmergedRequirement(product) || hasUnsupportedService(product)) return undefined;

  const locked = extractLockedConstraints(product, userMessages(product));
  if (classifyItineraryInputMode(locked, days, product.planning?.userIntent) !== "complete") return undefined;
  const order = reliableCompleteOrder(locked.itineraryOrder, days);
  if (!order) return undefined;

  const alternativeGroups = explicitAlternativeGroups(product);
  const expandedOrder = expandAlternativeGroups(order, alternativeGroups);
  if (!expandedOrder || expandedOrder.some((row) => row.spots.every(isTravelService))) return undefined;
  const itinerary = expandedOrder.map((row) => projectDay({
    row,
    days,
    nights: positiveInteger(basic?.nights) ?? 0,
    fallbackStay: text(basic?.meetingCity) || text(basic?.destinationCity),
    rawDayText: rawDayText(product, row.day),
    alternativeGroups,
  }));
  if (itineraryStructureError({ ...product.product, itinerary }) || itineraryInputContractError(product, itinerary)) return undefined;
  return {
    reply: "已按用户完整逐日行程生成待核验草案，保留原日序、景点顺序和二选一关系。",
    modules: [{ module: "itinerary", status: "proposed", value: itinerary }],
  };
}

function projectDay(args: {
  row: LockedDay;
  days: number;
  nights: number;
  fallbackStay: string;
  rawDayText: string;
  alternativeGroups: Array<{ day: number; names: string[] }>;
}): JsonObject {
  const travelServices = serviceNotes(args.rawDayText, args.row.spots);
  const attractions = args.row.spots.filter((name) => !isTravelService(name));
  const groups = args.alternativeGroups.filter((group) => group.day === args.row.day);
  const title = formatAttractionSequence(attractions, groups, " · ");
  const description = formatAttractionSequence(attractions, groups, "、");
  const spots = attractions.map((name, index) => ({
    name,
    kind: "attraction",
    poiName: null,
    poiId: null,
    timeOfDay: timeFor(index, attractions.length, groups, name),
    relation: groups.some((group) => group.names.some((candidate) => samePlace(candidate, name))) ? "or" : "and",
  }));
  const stay = stayForDay(args);
  return {
    day: args.row.day,
    title,
    spots,
    description: [
      `按用户原定顺序安排：${description}。`,
      ...travelServices,
      stay ? `当晚按用户要求住${stay}，酒店待运营匹配。` : "当日返程，不安排住宿。",
    ].join(""),
    hotel: stay ? `${stay}（待匹配）` : "无",
    meals: "自理",
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
    if (!day || !spots.length || byDay.has(day)) return undefined;
    byDay.set(day, { day, spots });
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
  const explicit = args.rawDayText.match(/(?:住宿|入住|住(?!宿))\s*(?:为|：|:)?\s*([^—–\-，,、。；;\n]{2,30})/u)?.[1]?.trim();
  return explicit || args.fallbackStay || "当地酒店";
}

function rawDayText(product: ProductDetail, day: number): string {
  const sections = [text(record(product.product.basicInfo)?.userIdea), ...userMessages(product).map((message) => message.content)]
    .map((value) => daySection(value, day))
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
  return userMessages(product).some((message) => message.content.trim() !== original
    && !isPlanningControlMessage(message.content));
}

/** The compact projector records only the train services it can preserve in a
 * description. Other service forms retain their established model handling. */
function hasUnsupportedService(product: ProductDetail): boolean {
  return [text(record(product.product.basicInfo)?.userIdea), ...userMessages(product).map((message) => message.content)]
    .some((value) => /(?:接机|送机|接团|送团)/u.test(value));
}

function daySection(value: string, day: number): string {
  const marker = /(?:D\s*([0-9一二三四五六七八九十]+)\s*天?|第\s*([0-9一二三四五六七八九十]+)\s*天)/giu;
  const matches = [...value.matchAll(marker)];
  const index = matches.findIndex((match) => DAY_TOKEN[match[1] ?? match[2] ?? ""] === day);
  if (index < 0) return "";
  const current = matches[index]!;
  const start = (current.index ?? 0) + current[0].length;
  return value.slice(start, matches[index + 1]?.index ?? value.length);
}

function serviceNotes(raw: string, spots: string[]): string[] {
  const notes: string[] = [];
  if (/(?:接火车|火车站接|接站)/u.test(raw) || spots.some((name) => /(?:接火车|火车站接|接站)/u.test(name))) notes.push("含火车站接站服务。");
  if (/(?:送火车|送站)/u.test(raw) || spots.some((name) => /(?:送火车|送站)/u.test(name))) notes.push("含火车站送站服务。");
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
  return /^(?:接火车站?|火车站接|送火车站?|接站|送站|接机|送机|接团|送团)(?:返程)?$/u.test(name.trim());
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
