import { isKnownPoiNameAlias } from "./poi-name-aliases.js";
import { isItinerarySpotId, itinerarySpotKey } from "./itinerary-spot-identity.js";

type Json = Record<string, unknown>;
export type TrustedItineraryRemoval = {
  day: number;
  name: string;
  removedAt: string;
  groupKey?: string;
  poiName?: string;
  poiId?: number;
  /** 被删景点的稳定身份；旧凭证没有该字段。 */
  spotId?: string;
};
export type TrustedItineraryRemovalIdentity = { poiName?: string; poiId?: number; spotId?: string };

/** Stable identity for one ordered, same-time `or` group. */
export function alternativeGroupKey(day: number, names: readonly string[]): string {
  return `or:${day}:${names.map(itinerarySpotKey).join("\u001f")}`;
}

/** 取出 groupKey 在指定天下的各段名称（逐段按 itinerarySpotKey 归一化）；前缀不符返回 undefined。 */
export function alternativeGroupSegments(groupKey: string, day: number): string[] | undefined {
  const prefix = `or:${day}:`;
  return groupKey.startsWith(prefix) ? groupKey.slice(prefix.length).split("\u001f").map(itinerarySpotKey) : undefined;
}

/**
 * 两个 groupKey 是否指同一个 OR 组。旧凭证按「仅去空白」生成，新 key 按 poiNameKey 生成，
 * 所以不能直接做字符串相等：同一天、段数相同、逐段 itinerarySpotKey 相等即视为同一组。
 */
export function sameAlternativeGroupKey(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return !left && !right;
  if (left === right) return true;
  const day = /^or:(\d+):/u.exec(left)?.[1];
  if (!day || !right.startsWith(`or:${day}:`)) return false;
  const a = alternativeGroupSegments(left, Number(day)); const b = alternativeGroupSegments(right, Number(day));
  return Boolean(a && b) && a!.length === b!.length && a!.every((segment, index) => segment === b![index]);
}

/** A receipt can only be written through the trusted manual-review IPC. */
export function hasTrustedOperatorItineraryRemoval(
  product: Json, day: number, name: string, groupKey?: string, ambiguous = false,
): boolean {
  const matches = removals(product).filter((item) => item.day === day
    && (sameName(item.name, name) || Boolean(item.poiName && isKnownPoiNameAlias(item.poiName, name))));
  if (groupKey) return matches.some((item) => sameAlternativeGroupKey(item.groupKey, groupKey) || (!item.groupKey && !ambiguous));
  return matches.some((item) => !item.groupKey);
}

export function appendTrustedOperatorItineraryRemoval(
  product: Json, day: number, name: string, removedAt: string, groupKey?: string,
  identity: TrustedItineraryRemovalIdentity = {},
): void {
  const manualReview = record(product.manualReview) ?? {}; const current = removals(product);
  const existing = current.find((item) => item.day === day && sameName(item.name, name) && sameAlternativeGroupKey(item.groupKey, groupKey));
  if (existing) applyIdentity(existing, identity);
  else {
    const receipt: TrustedItineraryRemoval = { day, name: name.trim(), removedAt, ...(groupKey ? { groupKey } : {}) };
    applyIdentity(receipt, identity); current.push(receipt);
  }
  manualReview.itinerarySpotRemovals = current; product.manualReview = manualReview;
}

/** Upgrade an existing legacy receipt after the same rejected POI reappears under an alias. */
export function bindTrustedOperatorItineraryRemovalIdentity(
  product: Json, day: number, name: string, identity: TrustedItineraryRemovalIdentity,
): boolean {
  const current = removals(product);
  const receipt = current.find((item) => item.day === day && sameName(item.name, name));
  if (!receipt) return false;
  const before = JSON.stringify(receipt); applyIdentity(receipt, identity);
  if (before === JSON.stringify(receipt)) return false;
  const manualReview = record(product.manualReview) ?? {};
  manualReview.itinerarySpotRemovals = current; product.manualReview = manualReview;
  return true;
}

/** A later explicit operator instruction restores this exact receipt. */
export function clearTrustedOperatorItineraryRemoval(product: Json, day: number, name: string, groupKey?: string): boolean {
  const current = removals(product);
  const next = current.filter((item) => !(item.day === day && sameName(item.name, name) && (groupKey ? sameAlternativeGroupKey(item.groupKey, groupKey) : !item.groupKey)));
  if (next.length === current.length) return false;
  const manualReview = record(product.manualReview) ?? {}; manualReview.itinerarySpotRemovals = next; product.manualReview = manualReview;
  return true;
}

/** A raw JSON save that visibly restores a removed slot revokes its old receipt. */
export function clearReappearedTrustedOperatorItineraryRemovals(product: Json): boolean {
  const current = removals(product); const itinerary = Array.isArray(product.itinerary) ? product.itinerary : [];
  const next = current.filter((receipt) => !receiptReappeared(receipt, itinerary));
  if (next.length === current.length) return false;
  const manualReview = record(product.manualReview) ?? {}; manualReview.itinerarySpotRemovals = next; product.manualReview = manualReview;
  return true;
}

export function trustedOperatorItineraryRemovals(product: Json): ReadonlyArray<TrustedItineraryRemoval> { return removals(product); }
/** Raw JSON and AI patches must preserve receipts exactly; only a visible re-add can clear one. */
export function sameTrustedOperatorItineraryRemovals(current: Json, next: Json): boolean { return JSON.stringify(removals(current)) === JSON.stringify(removals(next)); }

function receiptReappeared(receipt: TrustedItineraryRemoval, itinerary: unknown[]): boolean {
  // 同一个 spotId 出现在任意一天，说明运营显式写回了这个景点。
  if (receipt.spotId && itinerary.some((item) => spotsOf(item).some((spot) => record(spot)?.spotId === receipt.spotId))) return true;
  const day = itinerary.find((item) => Number(record(item)?.day) === receipt.day);
  const spots = spotsOf(day);
  for (let index = 0; index < spots.length; index += 1) {
    const spot = record(spots[index]); if (!spot || !sameName(text(spot.name), receipt.name)) continue;
    if (!receipt.groupKey) return true;
    if (groupReappeared(receipt.groupKey, receipt.day, spots, index)) return true;
  }
  return false;
}
function spotsOf(day: unknown): unknown[] { const spots = record(day)?.spots; return Array.isArray(spots) ? spots : []; }
/** 旧凭证的 groupKey 按去空白生成，这里对每一段重新归一化后再比较。 */
function groupReappeared(groupKey: string, day: number, spots: readonly unknown[], index: number): boolean {
  const names = alternativeGroupSegments(groupKey, day)?.filter(Boolean); if (!names) return false;
  const position = names.indexOf(itinerarySpotKey(record(spots[index])?.name)); if (position < 0) return false;
  const start = index - position;
  return start >= 0 && names.every((name, offset) => itinerarySpotKey(record(spots[start + offset])?.name) === name);
}
function removals(product: Json): TrustedItineraryRemoval[] {
  const manualReview = record(product.manualReview); const value = Array.isArray(manualReview?.itinerarySpotRemovals) ? manualReview.itinerarySpotRemovals : [];
  return value.flatMap((item) => {
    const receipt = record(item); const day = Number(receipt?.day); const name = text(receipt?.name); const removedAt = text(receipt?.removedAt); const groupKey = text(receipt?.groupKey);
    const poiName = text(receipt?.poiName); const poiId = Number(receipt?.poiId); const spotId = receipt?.spotId;
    return Number.isInteger(day) && day > 0 && name && removedAt ? [{ day, name, removedAt,
      ...(groupKey ? { groupKey } : {}), ...(poiName ? { poiName } : {}), ...(isItinerarySpotId(spotId) ? { spotId } : {}),
      ...(Number.isInteger(poiId) && poiId > 0 ? { poiId } : {}) }] : [];
  });
}
function applyIdentity(receipt: TrustedItineraryRemoval, identity: TrustedItineraryRemovalIdentity): void {
  const poiName = text(identity.poiName); const poiId = Number(identity.poiId);
  if (poiName) receipt.poiName = poiName;
  if (Number.isInteger(poiId) && poiId > 0) receipt.poiId = poiId;
  if (isItinerarySpotId(identity.spotId)) receipt.spotId = identity.spotId;
}
function sameName(left: string, right: string): boolean { const a = itinerarySpotKey(left); return Boolean(a) && a === itinerarySpotKey(right); }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function record(value: unknown): Json | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined; }
