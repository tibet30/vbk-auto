type Json = Record<string, unknown>;
export type TrustedItineraryRemoval = { day: number; name: string; removedAt: string; groupKey?: string };

/** Stable identity for one ordered, same-time `or` group. */
export function alternativeGroupKey(day: number, names: readonly string[]): string {
  return `or:${day}:${names.map(normalise).join("\u001f")}`;
}

/** A receipt can only be written through the trusted manual-review IPC. */
export function hasTrustedOperatorItineraryRemoval(
  product: Json, day: number, name: string, groupKey?: string, ambiguous = false,
): boolean {
  const matches = removals(product).filter((item) => item.day === day && sameName(item.name, name));
  if (groupKey) return matches.some((item) => item.groupKey === groupKey || (!item.groupKey && !ambiguous));
  return matches.some((item) => !item.groupKey);
}

export function appendTrustedOperatorItineraryRemoval(
  product: Json, day: number, name: string, removedAt: string, groupKey?: string,
): void {
  const manualReview = record(product.manualReview) ?? {}; const current = removals(product);
  if (!current.some((item) => item.day === day && sameName(item.name, name) && item.groupKey === groupKey)) {
    current.push({ day, name: name.trim(), removedAt, ...(groupKey ? { groupKey } : {}) });
  }
  manualReview.itinerarySpotRemovals = current; product.manualReview = manualReview;
}

/** A later explicit operator instruction restores this exact receipt. */
export function clearTrustedOperatorItineraryRemoval(product: Json, day: number, name: string, groupKey?: string): boolean {
  const current = removals(product);
  const next = current.filter((item) => !(item.day === day && sameName(item.name, name) && (groupKey ? item.groupKey === groupKey : !item.groupKey)));
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
  const day = itinerary.find((item) => Number(record(item)?.day) === receipt.day);
  const spots = Array.isArray(record(day)?.spots) ? record(day)!.spots as unknown[] : [];
  for (let index = 0; index < spots.length; index += 1) {
    const spot = record(spots[index]); if (!spot || !sameName(text(spot.name), receipt.name)) continue;
    if (!receipt.groupKey) return true;
    if (groupReappeared(receipt.groupKey, receipt.day, spots, index)) return true;
  }
  return false;
}
function groupReappeared(groupKey: string, day: number, spots: readonly unknown[], index: number): boolean {
  const prefix = `or:${day}:`; if (!groupKey.startsWith(prefix)) return false;
  const names = groupKey.slice(prefix.length).split("\u001f").filter(Boolean);
  const position = names.indexOf(normalise(text(record(spots[index])?.name))); if (position < 0) return false;
  const start = index - position;
  return start >= 0 && names.every((name, offset) => normalise(text(record(spots[start + offset])?.name)) === name);
}
function removals(product: Json): TrustedItineraryRemoval[] {
  const manualReview = record(product.manualReview); const value = Array.isArray(manualReview?.itinerarySpotRemovals) ? manualReview.itinerarySpotRemovals : [];
  return value.flatMap((item) => {
    const receipt = record(item); const day = Number(receipt?.day); const name = text(receipt?.name); const removedAt = text(receipt?.removedAt); const groupKey = text(receipt?.groupKey);
    return Number.isInteger(day) && day > 0 && name && removedAt ? [{ day, name, removedAt, ...(groupKey ? { groupKey } : {}) }] : [];
  });
}
function sameName(left: string, right: string): boolean { const a = normalise(left); const b = normalise(right); return Boolean(a) && a === b; }
function normalise(value: string): string { return value.replace(/\s+/g, "").trim(); }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function record(value: unknown): Json | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined; }
