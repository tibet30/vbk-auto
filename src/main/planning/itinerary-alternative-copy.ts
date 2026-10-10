import type { ProductDetail } from "../../shared/contracts.js";
import { explicitAlternativeGroups, hasTrustedOperatorAlternativeDeletion } from "./itinerary-input-contract.js";

type JsonObject = Record<string, unknown>;

export interface ExcludedItineraryAlternativeGroup {
  day: number;
  group: { day: number; names: string[] };
  names: string[];
}

/**
 * Finds only original OR options that a trusted operator explicitly removed.
 * POI lookup failures and active-itinerary gaps never authorize deletion.
 */
export function excludedItineraryAlternatives(product: ProductDetail, itinerary: unknown): Map<number, string[]> {
  const excluded = new Map<number, string[]>();
  for (const group of excludedItineraryAlternativeGroups(product, itinerary)) {
    excluded.set(group.day, [...(excluded.get(group.day) ?? []), ...group.names]);
  }
  return excluded;
}

/** Group identity must survive until the decision that mutates copy or readiness. */
export function excludedItineraryAlternativeGroups(
  product: ProductDetail,
  itinerary: unknown,
): ExcludedItineraryAlternativeGroup[] {
  if (!Array.isArray(itinerary)) return [];
  const excluded: ExcludedItineraryAlternativeGroup[] = [];
  for (const group of explicitAlternativeGroups(product)) {
    const names = group.names.filter((name) => hasTrustedOperatorAlternativeDeletion(product, group.day, name, group));
    if (names.length) excluded.push({ day: group.day, group, names });
  }
  return excluded;
}

/**
 * Synchronise customer-facing copy after an OR group has converged.  It is
 * intentionally idempotent so historical itineraries may be repaired later.
 */
export function removeExcludedAlternativeCopy(
  day: JsonObject,
  removed: readonly string[],
  kept = attractionNames(day),
  titleSpots = attractionNames(day),
): void {
  if (!removed.length) return;
  const title = text(day.title);
  if (titleSpots.length && (containsExcludedAlternativeMention(title, removed) || hasTitleChoiceExpression(title))) {
    day.title = titleSpots.join(" · ");
  }
  const source = text(day.description);
  if (!source) return;
  const standard = source.match(/^(按用户原定顺序安排：)[^。]*。/u);
  if (standard && titleSpots.length) {
    day.description = `${standard[1]}${titleSpots.join("、")}。${source.slice(standard[0].length)}`;
    return;
  }
  const next = splitSentences(source).map((sentence) => rewriteSentence(sentence, removed, kept)).join("");
  if (next !== source) day.description = next;
}

/** Shared mention aliases for full and abbreviated original itinerary names. */
export function alternativeMentionAliases(name: string): string[] {
  const exact = name.trim();
  const action = exact.match(/(参观|游览|打卡)$/u)?.[1] ?? "";
  const simplified = exact
    .replace(/^(?:日喀则|拉萨|江孜|萨迦)/u, "")
    .replace(/非物质(?:文化)?遗产/gu, "非遗")
    .replace(/(?:参观|游览|打卡)$/u, "");
  const shortActivity = action && /^非遗(?:中心)?$/u.test(simplified)
    ? `${simplified.replace(/中心$/u, "")}${action}` : "";
  const localName = exact.replace(/^[\p{Script=Han}]{1,8}?(?:市|县)/u, "");
  const museumName = localName.endsWith("博物馆") ? localName.replace(/博物馆$/u, "") : "";
  return [...new Set([exact, exact.replace(/(?:参观|游览|打卡)$/u, ""), simplified, shortActivity, localName,
    ...(museumName.length >= 3 ? [museumName] : [])].filter(Boolean))]
    .sort((left, right) => right.length - left.length);
}

/** True only when an excluded option is mentioned as an itinerary activity, never as a hotel name. */
export function containsExcludedAlternativeMention(copy: string, removed: readonly string[]): boolean {
  return removed.flatMap(alternativeMentionAliases).some((name) => hasActivityMention(copy, name));
}

/** Pure repair for already-converged itineraries that no longer enter self-repair. */
export function repairExcludedAlternativeCopy(product: ProductDetail, itinerary: unknown): {
  itinerary: JsonObject[];
  changed: boolean;
  excluded: Map<number, string[]>;
} {
  const next = Array.isArray(itinerary) ? itinerary.filter(isRecord).map((day) => structuredClone(day)) : [];
  const excludedGroups = excludedItineraryAlternativeGroups(product, next);
  const excluded = excludedItineraryAlternatives(product, next);
  for (const day of next) {
    const titleSpots = attractionNames(day);
    for (const exclusion of excludedGroups.filter((item) => item.day === Number(day.day))) {
      const group = exclusion.group;
      const groupRemoved = exclusion.names;
      if (groupRemoved.some((name) => titleSpots.some((item) => samePlace(item, name)))) continue;
      const kept = group.names.filter((name) => titleSpots.some((item) => samePlace(item, name)));
      removeExcludedAlternativeCopy(day, groupRemoved, kept, titleSpots);
    }
  }
  return { itinerary: next, changed: JSON.stringify(itinerary) !== JSON.stringify(next), excluded };
}

function rewriteSentence(source: string, removed: readonly string[], kept: readonly string[]): string {
  const removedAliases = removed.flatMap(alternativeMentionAliases);
  if (!containsExcludedAlternativeMention(source, removed)) return source;
  let next = removedAliases.reduce(removeAlternativeName, source);
  const hasChoice = hasChoiceExpression(source);
  const hasKept = kept.flatMap(alternativeMentionAliases).some((name) => hasActivityMention(source, name));
  if (hasChoice && hasKept && kept.length === 1) next = next.replace(/(?:二选一|多选一|任选其一)/gu, "");
  return tidyCopy(next);
}

function hasChoiceExpression(value: string): boolean {
  return /(?:或者|或|二选一|多选一|任选其一)/u.test(value);
}

function hasTitleChoiceExpression(value: string): boolean {
  return /(?:二选一|多选一|任选其一)/u.test(value);
}

function removeAlternativeName(source: string, name: string): string {
  const escaped = escapeRegExp(name);
  const tail = "(?=\\s*(?:[、，,·/／→。；;]|$|或者|或|与|和|等(?:人文)?景点|等人文|二选一|多选一|任选其一|参观|游览|安排|打卡|后|再|并))";
  return source
    .replace(new RegExp(`(?:或者|或|与|和)\\s*${escaped}${tail}`, "gu"), "")
    .replace(new RegExp(`${escaped}\\s*(?:或者|或|与|和)`, "gu"), "")
    .replace(new RegExp(`(^|[、，,·/／→])\\s*${escaped}${tail}`, "gu"), "$1");
}

function hasActivityMention(source: string, name: string): boolean {
  const escaped = escapeRegExp(name);
  return new RegExp(`(^|[、，,·/／→\\s]|(?:或者|或|与|和)|安排|前往|游览|参观)${escaped}(?=\\s*(?:[、，,·/／→。；;]|$|或者|或|与|和|等(?:人文)?景点|等人文|二选一|多选一|任选其一|参观|游览|安排|打卡|后|再|并))`, "u").test(source);
}

function tidyCopy(value: string): string {
  let next = value;
  while (/[、，,·/／→]\s*(?=[、，,·/／→])/u.test(next)) next = next.replace(/[、，,·/／→]\s*(?=[、，,·/／→])/gu, "");
  return next.replace(/^[、，,·/／→]\s*/u, "").replace(/\s*[、，,·/／→]$/u, "").trim();
}

function attractionNames(day: JsonObject): string[] {
  return (Array.isArray(day.spots) ? day.spots : []).filter(isRecord)
    .filter((spot) => spot.kind !== "other" && spot.kind !== "free")
    .map(spotName).filter(Boolean);
}

function splitSentences(value: string): string[] {
  return value.match(/[^。！？!?]*[。！？!?]?/gu)?.filter(Boolean) ?? [value];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function spotName(value: JsonObject): string { return text(value.name) || text(value.poiName); }
function samePlace(left: string, right: string): boolean {
  const a = left.replace(/\s+/g, "");
  const b = right.replace(/\s+/g, "");
  return Boolean(a) && Boolean(b) && (a === b || a.includes(b) || b.includes(a));
}
function isRecord(value: unknown): value is JsonObject { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
