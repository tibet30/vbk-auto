import { trustedOperatorItineraryRemovals, alternativeGroupKey } from "./trusted-operator-itinerary-removals.js";

type Json = Record<string, unknown>;

/** Latest operator receipts override stale AI/resource snapshots, including incidental itinerary copy. */
export function preserveItineraryRemovals(current: Json, incoming: Json): Json {
  const receipts = trustedOperatorItineraryRemovals(current);
  if (!receipts.length && !trustedOperatorItineraryRemovals(incoming).length) return incoming;
  const next = structuredClone(incoming);
  next.manualReview = { ...record(next.manualReview), itinerarySpotRemovals: structuredClone(receipts) };
  for (const value of Array.isArray(next.itinerary) ? next.itinerary : []) {
    const day = record(value);
    const spots: unknown[] = Array.isArray(day.spots) ? day.spots : [];
    const scoped = receipts.filter((receipt) => receipt.day === Number(day.day));
    const deleted = new Set<number>();
    for (const [index, spot] of spots.entries()) {
      const name = text(record(spot).name);
      if (scoped.some((receipt) => compact(receipt.name) === compact(name)
        && (!receipt.groupKey || groupMatches(spots, index, Number(day.day), receipt.groupKey)))) deleted.add(index);
    }
    day.spots = spots.filter((_, index) => !deleted.has(index));
    // A surviving OR peer is no longer a choice when every other peer was removed.
    for (const index of deleted) {
      const group = groupIndexes(spots, index);
      const kept = group.filter((peer) => !deleted.has(peer));
      if (group.length > 1 && kept.length === 1) record(spots[kept[0]!]).relation = "and";
    }
    const remaining = (day.spots as unknown[]).map((spot) => compact(text(record(spot).name)));
    const removed = scoped.filter((receipt) => !remaining.includes(compact(receipt.name)));
    const aliases = removed.flatMap((receipt) => mentionAliases(receipt.name));
    if (!aliases.length) continue;
    if (Array.isArray(day.activities)) {
      day.activities = day.activities.filter((activity) => !aliases.includes(text(record(activity).title)));
    }
    for (const field of ["title", "description"] as const) {
      const copy = text(day[field]);
      if (!copy || !aliases.some((name) => copy.includes(name))) continue;
      // Keep unrelated clauses, rather than rebuilding a day from an old model response.
      day[field] = (copy.match(/[^，,。！？!?]+[，,。！？!?]?/gu) ?? [])
        .filter((clause) => !aliases.some((name) => clause.includes(name)))
        .join("").replace(/[，,]$/u, "。").trim();
      if (!day[field]) {
        const kept = (day.spots as unknown[]).map((spot) => text(record(spot).name)).filter(Boolean).join("、");
        day[field] = field === "title" ? kept || `第${day.day}天行程`
          : kept ? `当日安排：${kept}。` : `第${day.day}天行程以已确认安排为准。`;
      }
    }
  }
  return next;
}

function mentionAliases(name: string): string[] {
  const full = name.trim();
  const short = full.replace(/^[\p{Script=Han}]{1,8}?(?:市|县)/u, "");
  return [...new Set([full, short].filter((value) => value.length >= 2))];
}

function groupMatches(spots: readonly unknown[], index: number, day: number, key: string): boolean {
  const prefix = `or:${day}:`;
  if (!key.startsWith(prefix)) return false;
  const names = key.slice(prefix.length).split("\u001f");
  const position = names.indexOf(compact(text(record(spots[index]).name)));
  const start = index - position;
  return position >= 0 && start >= 0
    && alternativeGroupKey(day, spots.slice(start, start + names.length).map((spot) => text(record(spot).name))) === key;
}

function groupIndexes(spots: readonly unknown[], index: number): number[] {
  const spot = record(spots[index]);
  if (spot.relation !== "or") return [];
  const peer = (value: unknown) => record(value).relation === "or" && record(value).timeOfDay === spot.timeOfDay;
  let start = index; let end = index;
  while (start > 0 && peer(spots[start - 1])) start--;
  while (end + 1 < spots.length && peer(spots[end + 1])) end++;
  return Array.from({ length: end - start + 1 }, (_, offset) => start + offset);
}

function record(value: unknown): Json { return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {}; }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function compact(value: string): string { return value.replace(/\s+/g, ""); }
