import { toPlatformShortLocationName } from "../../shared/location-short-name.js";
import type { ProductDetail } from "../../shared/contracts.js";
import type { PlanningUserIntent } from "../../shared/contracts-planning-intent.js";
import type { ItineraryInputMode, LockedConstraints, LockedItineraryDay } from "../../shared/contracts-preparation.js";
import { extractLockedConstraints } from "../agent/prompt-helpers.js";
import { hasCompleteDailyUserItinerary } from "./user-intent.js";

const DAY_TOKEN: Record<string, number> = {
  "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9, "10": 10,
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

export function classifyItineraryInputMode(
  locked: LockedConstraints,
  days: number,
  intent?: PlanningUserIntent,
): ItineraryInputMode {
  if ((intent && hasCompleteDailyUserItinerary(intent, days)) || coversAllDays(locked.itineraryOrder, days)) {
    return "complete";
  }
  if (locked.pois.length || locked.itineraryOrder.length || (intent?.activities.some((activity) => activity.kind === "poi" || activity.day > 0))) {
    return "partial";
  }
  return "open";
}

export function itineraryInputContractError(product: ProductDetail, nextItinerary: unknown): string | undefined {
  const locked = extractLockedConstraints(product, userMessages(product));
  const days = locked.days ?? 0;
  const mode = classifyItineraryInputMode(locked, days, product.planning?.userIntent);
  const itinerary = asDayList(nextItinerary);
  if (!itinerary) return "行程必须是逐日列表。";
  if (days > 0 && itinerary.length !== days) {
    return `行程天数必须保持为已锁定的 ${days} 天，不能改成 ${itinerary.length} 天。`;
  }
  const alternativeError = explicitAlternativeGroupError(product, itinerary);
  if (alternativeError) return alternativeError;
  if (mode === "open") return undefined;

  const byDay = new Map(itinerary.map((day) => [Number(day.day), spotNames(day)]));
  for (const row of locked.itineraryOrder) {
    const names = byDay.get(row.day) ?? [];
    if (mode === "complete") {
      if (!isNameSubsequence(names, row.spots)) {
        return `用户已给出完整第 ${row.day} 天行程，禁止整体重排或替换；只能规范化并核验 POI。缺失：${missingNames(names, row.spots).join("、") || row.spots.join("、")}`;
      }
      const extras = extraNames(names, row.spots);
      if (extras.length) {
        return `用户已给出完整第 ${row.day} 天行程，不能新增或替换景点：${extras.join("、")}`;
      }
    } else if (!row.spots.every((spot) => names.some((name) => samePlace(name, spot)))) {
      return `已锁定的第 ${row.day} 天景点必须保留：${row.spots.join("、")}`;
    }
  }
  if (mode === "partial") {
    const allNames = itinerary.flatMap(spotNames);
    const missing = locked.pois.filter((poi) => !allNames.some((name) => samePlace(name, poi)));
    if (missing.length) return `已锁定的指定 POI 必须保留：${missing.join("、")}`;
  }
  return undefined;
}

export function planningWriteContractError(
  product: ProductDetail,
  module: string,
  value: unknown,
): string | undefined {
  if (module === "itinerary") return itineraryInputContractError(product, value);
  const locked = extractLockedConstraints(product, userMessages(product));
  const record = asRecord(value);
  if (!record) return undefined;
  if (module !== "basicInfo" && module !== "skeleton" && module !== "operations") return undefined;
  if (locked.days && record.days !== undefined && Number(record.days) !== locked.days) {
    return `出行天数已锁定为 ${locked.days} 天，不能改为 ${record.days}`;
  }
  if (locked.meetingCity && text(record.meetingCity) && shortCity(record.meetingCity) !== locked.meetingCity) {
    return `meetingCity 已锁定为「${locked.meetingCity}」，不能覆盖`;
  }
  if (locked.destinationCity && text(record.destinationCity) && shortCity(record.destinationCity) !== locked.destinationCity) {
    return `destinationCity 必须与已锁定城市「${locked.destinationCity}」相同`;
  }
  if (locked.transport && record.transport !== undefined && record.transport !== locked.transport) {
    return `交通方式已锁定为 ${locked.transport}，不能覆盖`;
  }
  return undefined;
}

function coversAllDays(order: LockedItineraryDay[], days: number): boolean {
  if (days < 1 || !order.length) return false;
  const planned = new Set(order.filter((row) => row.spots.length).map((row) => row.day));
  return Array.from({ length: days }, (_, index) => planned.has(index + 1)).every(Boolean);
}

function userMessages(product: ProductDetail): Array<{ role: string; content: string }> {
  return (product.messages ?? [])
    .filter((message) => message.role === "user")
    .map((message) => ({ role: "user", content: message.content }));
}

function asDayList(value: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const days: Record<string, unknown>[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
    days.push(item as Record<string, unknown>);
  }
  return days;
}

function spotNames(day: Record<string, unknown>): string[] {
  return (Array.isArray(day.spots) ? day.spots : [])
    .flatMap((spot) => {
      if (typeof spot === "string") return [spot.trim()];
      const record = asRecord(spot);
      return record ? [text(record.name) || text(record.poiName)] : [];
    })
    .filter(Boolean);
}

/**
 * 二选一不是在规划期挑出一个默认项：所有原始选项都要保留在同一天的同一段，
 * 再由 VBK 的 orFlag 表达“任选其一”。这层也覆盖对话式 patch 路径，避免
 * 只走三阶段 planner 时才生效。
 */
function explicitAlternativeGroupError(
  product: ProductDetail,
  itinerary: Record<string, unknown>[],
): string | undefined {
  const groups = explicitAlternativeGroups(product);
  if (!groups.length) return undefined;
  const days = new Map(itinerary.map((day) => [Number(day.day), day]));
  for (const group of groups) {
    const day = days.get(group.day);
    const spots = Array.isArray(day?.spots) ? day.spots.filter(asRecord) : [];
    const matches = group.names.map((name) => ({ name, index: spots.findIndex((spot) => samePlace(spotName(spot), name)) }));
    const missing = matches.filter((match) => match.index < 0).map((match) => match.name);
    if (missing.length) return `第 ${group.day} 天的二选一景点必须全部保留：${missing.join("、")}`;
    const selected = matches.map((match) => spots[match.index]!);
    if (!selected.every((spot) => spot.relation === "or")) {
      return `第 ${group.day} 天的二选一景点「${group.names.join("或")}」必须都标记为 relation: "or"。`;
    }
    const times = new Set(selected.map((spot) => spot.timeOfDay).filter((time): time is string => time === "morning" || time === "afternoon"));
    if (times.size !== 1) return `第 ${group.day} 天的二选一景点「${group.names.join("或")}」必须位于同一时段。`;
    const indexes = matches.map((match) => match.index).sort((left, right) => left - right);
    if (indexes.some((index, position) => position > 0 && index !== indexes[position - 1]! + 1)) {
      return `第 ${group.day} 天的二选一景点「${group.names.join("或")}」必须连续放在同一段行程。`;
    }
  }
  return undefined;
}

function explicitAlternativeGroups(product: ProductDetail): Array<{ day: number; names: string[] }> {
  const structured = (product.planning?.userIntent?.activities ?? []).flatMap((activity) => {
    const names = unique([activity.title, ...(activity.alternatives ?? [])]);
    return activity.kind === "poi" && activity.day > 0 && names.length > 1 ? [{ day: activity.day, names }] : [];
  });
  const basic = asRecord(product.product.basicInfo);
  const raw = text(basic?.userIdea);
  const parsed = rawAlternativeGroups(raw);
  return uniqueGroups([...structured, ...parsed]);
}

function rawAlternativeGroups(value: string): Array<{ day: number; names: string[] }> {
  const marker = /(?:D|d|第)\s*([0-9一二三四五六七八九十]+)\s*天?/g;
  const matches = [...value.matchAll(marker)];
  return matches.flatMap((match, index) => {
    const day = DAY_TOKEN[match[1] ?? ""] ?? Number(match[1]);
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? value.length;
    if (!Number.isInteger(day) || day < 1) return [];
    return value.slice(start, end).split(/[-—–]+/u).flatMap((segment) => {
      if (!/(?:二选一|多选一|任选其一)/u.test(segment) || !/(?:或者|或|\/|／)/u.test(segment)) return [];
      const names = unique(segment
        .replace(/【[^】]*】|\[[^\]]*\]|\([^)]*\)|（[^）]*）/gu, "")
        .replace(/(?:二选一|多选一|任选其一)/gu, "")
        .split(/\s*(?:或者|或|\/|／)\s*/u)
        .map(cleanAlternativeName));
      return names.length > 1 ? [{ day, names }] : [];
    });
  });
}

function cleanAlternativeName(value: string): string {
  return value
    .replace(/^[:：、，,\s]+/u, "")
    .replace(/^(?:去|游览|参观|安排)\s*/u, "")
    .trim();
}

function uniqueGroups(groups: Array<{ day: number; names: string[] }>): Array<{ day: number; names: string[] }> {
  const seen = new Set<string>();
  return groups.filter((group) => {
    const key = `${group.day}:${group.names.map((name) => name.replace(/\s+/g, "")).join("|")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function spotName(spot: Record<string, unknown>): string {
  return text(spot.name) || text(spot.poiName);
}

function isNameSubsequence(haystack: string[], needles: string[]): boolean {
  let index = 0;
  for (const name of haystack) {
    if (index < needles.length && samePlace(name, needles[index]!)) index += 1;
  }
  return index === needles.length;
}

function missingNames(haystack: string[], needles: string[]): string[] {
  return needles.filter((needle) => !haystack.some((name) => samePlace(name, needle)));
}

function extraNames(haystack: string[], needles: string[]): string[] {
  return haystack.filter((name) => !needles.some((needle) => samePlace(name, needle)));
}

function samePlace(left: string, right: string): boolean {
  const a = left.replace(/\s+/g, "");
  const b = right.replace(/\s+/g, "");
  return Boolean(a) && Boolean(b) && (a === b || a.includes(b) || b.includes(a));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function shortCity(value: unknown): string {
  return toPlatformShortLocationName(text(value));
}
