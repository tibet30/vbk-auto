import { trustedOperatorItineraryRemovals, alternativeGroupSegments } from "./trusted-operator-itinerary-removals.js";
import { samePoiName } from "./poi-name-key.js";
import { isItinerarySpotId, itinerarySpotExactName, itinerarySpotKey } from "./itinerary-spot-identity.js";

type Json = Record<string, unknown>;

/** Latest operator receipts override stale AI/resource snapshots, including incidental itinerary copy. */
export function preserveItineraryRemovals(current: Json, incoming: Json): Json {
  const receipts = trustedOperatorItineraryRemovals(current);
  if (!receipts.length && !trustedOperatorItineraryRemovals(incoming).length) return incoming;
  const next = structuredClone(incoming);
  next.manualReview = { ...record(next.manualReview), itinerarySpotRemovals: structuredClone(receipts) };
  const survivingIds = currentSpotIds(current);
  for (const value of Array.isArray(next.itinerary) ? next.itinerary : []) {
    const day = record(value);
    const spots: unknown[] = Array.isArray(day.spots) ? day.spots : [];
    const scoped = receipts.filter((receipt) => receipt.day === Number(day.day));
    const deleted = new Set<number>();
    for (const [index, spot] of spots.entries()) {
      const value = record(spot);
      if (scoped.some((receipt) => matchesReceipt(receipt, value, survivingIds)
        && (!receipt.groupKey || groupMatches(spots, index, Number(day.day), receipt.groupKey)))) deleted.add(index);
    }
    day.spots = spots.filter((_, index) => !deleted.has(index));
    // A surviving OR peer is no longer a choice when every other peer was removed.
    for (const index of deleted) {
      const group = groupIndexes(spots, index);
      const kept = group.filter((peer) => !deleted.has(peer));
      if (group.length > 1 && kept.length === 1) record(spots[kept[0]!]).relation = "and";
    }
    const remaining = (day.spots as unknown[]).map((spot) => itinerarySpotKey(record(spot).name));
    const removed = scoped.filter((receipt) => !remaining.includes(itinerarySpotKey(receipt.name)));
    const aliases = removed.flatMap((receipt) => [receipt.name, receipt.poiName].flatMap(mentionAliases));
    if (!aliases.length) continue;
    if (Array.isArray(day.activities)) {
      day.activities = day.activities.filter((activity) => !aliases.includes(text(record(activity).title)));
    }
    for (const field of ["title", "description"] as const) {
      const copy = text(day[field]);
      if (!copy || !aliases.some((name) => copy.includes(name))) continue;
      // 编号路线的标题用「—/→/·/，」串联同一行的多个路线点：标题优先按分段
      // 只删命中点。否则整句过滤在标题含其它分隔符时会连未删除的锚点一起丢掉，
      // 下文「编号路线校验」会把它们报成未保留。描述是散文，仍优先整句过滤。
      const segmented = dropRouteSegments(copy, aliases);
      const claused = dropMentionedClauses(copy, aliases);
      // 原始逐日路线（「门源 — 岗什卡雪峰 — 阿咪东索景区 | 宿祁连」）整句删除会
      // 连未删除的路线点一起丢掉，下一轮校验又报「门源」缺失并来回反复。
      // 含路线分隔符时按段删，保留同句的其它节点。
      const routeLike = /[—–→|｜]/u.test(copy);
      day[field] = field === "title" || routeLike ? segmented || claused : claused || segmented;
      if (!day[field]) {
        const kept = (day.spots as unknown[]).map((spot) => text(record(spot).name)).filter(Boolean).join("、");
        day[field] = field === "title" ? kept || `第${day.day}天行程`
          : kept ? `当日安排：${kept}。` : `第${day.day}天行程以已确认安排为准。`;
      }
    }
  }
  return next;
}

/** current 行程里已有的合法 spotId → 该景点去空白后的原名。 */
function currentSpotIds(current: Json): Map<string, string> {
  const ids = new Map<string, string>();
  for (const day of Array.isArray(current.itinerary) ? current.itinerary : []) {
    for (const spot of Array.isArray(record(day).spots) ? record(day).spots as unknown[] : []) {
      const value = record(spot);
      if (isItinerarySpotId(value.spotId)) ids.set(value.spotId, itinerarySpotExactName(value.name));
    }
  }
  return ids;
}

/**
 * 幸存景点：spotId 在 current 中，且去空白名称与 current 同 ID 景点一致。
 * 名称已变（换半角括号、换动作词等）的变体即使继承了 ID，也按新生成景点走名称键兜底。
 */
function isSurvivor(spot: Json, survivingIds: ReadonlyMap<string, string>): boolean {
  if (!isItinerarySpotId(spot.spotId)) return false;
  const name = survivingIds.get(spot.spotId);
  return name !== undefined && Boolean(name) && name === itinerarySpotExactName(spot.name);
}

/**
 * 幸存的既有景点（spotId 在 current 中且原名未变）只按 spotId / poiId / 精确 poiName / 精确原名匹配，
 * 不走名称键兜底：否则删「X（夜景）」会把同天幸存的「X」一起删掉。
 * 没有 ID、ID 不在 current 中或名称已变的景点（新生成/变体）仍走名称键兜底，重新生成的同名景点照旧被拦截（决策 3）。
 */
function matchesReceipt(
  receipt: { name: string; poiName?: string; poiId?: number; spotId?: string }, spot: Json, survivingIds: ReadonlyMap<string, string>,
): boolean {
  if (receipt.spotId && receipt.spotId === spot.spotId) return true;
  const spotPoiId = Number(spot.poiId);
  if (receipt.poiId && Number.isInteger(spotPoiId) && spotPoiId > 0 && receipt.poiId === spotPoiId) return true;
  if (isSurvivor(spot, survivingIds)) {
    const exact = (value: unknown) => itinerarySpotExactName(value);
    return Boolean(receipt.poiName && exact(receipt.poiName) && [spot.poiName, spot.name].some((name) => exact(name) === exact(receipt.poiName)))
      || Boolean(exact(receipt.name)) && exact(receipt.name) === exact(spot.name);
  }
  if (receipt.poiName && (samePoiName(receipt.poiName, spot.poiName) || samePoiName(receipt.poiName, spot.name))) return true;
  const key = itinerarySpotKey(receipt.name);
  return Boolean(key) && key === itinerarySpotKey(spot.name);
}

function mentionAliases(name: unknown): string[] {
  if (typeof name !== "string") return [];
  const full = name.trim();
  const short = full.replace(/^[\p{Script=Han}]{1,8}?(?:市|县)/u, "");
  return [...new Set([full, short].filter((value) => value.length >= 2))];
}

/** 整句过滤：只丢掉提到被删除景点的句子，保留无关文案。 */
function dropMentionedClauses(copy: string, aliases: readonly string[]): string {
  return (copy.match(/[^，,。！？!?]+[，,。！？!?]?/gu) ?? [])
    .filter((clause) => !aliases.some((name) => clause.includes(name)))
    .join("").replace(/[，,]$/u, "。").trim();
}

/** 只删命中删除凭证的路线点分段，保留同一标题里的其它锁定路线点。 */
function dropRouteSegments(copy: string, aliases: readonly string[]): string {
  return copy.split(/([—–\-·、，,→/／|｜])/u)
    .filter((part) => !aliases.some((name) => part.includes(name)))
    .join("")
    .replace(/^[\s—–\-·、，,→/／|｜]+|[\s—–\-·、，,→/／|｜]+$/gu, "")
    .replace(/([—–\-·、，,→/／|｜])\s*(?=[—–\-·、，,→/／|｜])/gu, "")
    .trim();
}

function groupMatches(spots: readonly unknown[], index: number, day: number, key: string): boolean {
  // 旧凭证的 groupKey 按去空白生成，逐段重新归一化后再比较。
  const names = alternativeGroupSegments(key, day);
  if (!names) return false;
  const position = names.indexOf(itinerarySpotKey(record(spots[index]).name));
  const start = index - position;
  return position >= 0 && start >= 0 && start + names.length <= spots.length
    && names.every((name, offset) => itinerarySpotKey(record(spots[start + offset]).name) === name);
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
