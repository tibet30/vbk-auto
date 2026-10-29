/**
 * 行程景点的稳定身份（spotId）。
 *
 * POI 绑定、删除凭证、核查任务凭证过去都靠名字或下标对齐景点，行程被别处改写后
 * 容易错位。这里给每个景点一个 `sp_` + 12 位小写十六进制的 ID，并提供：
 *   - 生成与格式判断；
 *   - 新方案对旧方案的 ID 继承（inheritItinerarySpotIds）；
 *   - 缺失 / 非法 / 重复 ID 的补齐（ensureItinerarySpotIds）；
 *   - 按 ID 定位（findItinerarySpot）。
 *
 * 名称比较统一走 poiNameKey，不要在别处再写一套归一化规则。
 * 非对象形式的 spot（字符串）原样保留，不带 ID。
 */

import { poiNameKey } from "./poi-name-key.js";

type Json = Record<string, unknown>;

const SPOT_ID_PATTERN = /^sp_[0-9a-f]{12}$/;

export function newItinerarySpotId(): string {
  return `sp_${globalThis.crypto.randomUUID().replace(/-/gu, "").slice(0, 12)}`;
}

export function isItinerarySpotId(value: unknown): value is string {
  return typeof value === "string" && SPOT_ID_PATTERN.test(value);
}

/** 景点名称比较的唯一入口，等同 poiNameKey。 */
export function itinerarySpotKey(name: unknown): string {
  return poiNameKey(name);
}

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function daysOf(product: Json): Json[] {
  const itinerary = product.itinerary;
  return Array.isArray(itinerary) ? itinerary.filter(isRecord) : [];
}

function spotsOf(day: Json): unknown[] {
  return Array.isArray(day.spots) ? day.spots : [];
}

function positivePoiId(spot: Json): number | undefined {
  const id = Number(spot.poiId);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

function freshId(taken: Set<string>): string {
  let id = newItinerarySpotId();
  while (taken.has(id)) id = newItinerarySpotId();
  return id;
}

interface OldSpot { id: string; exact: string; key: string; poiId: number | undefined }

/** 去空白后的原名，用于「同名」精确比较；比名称键更严格。 */
export function itinerarySpotExactName(name: unknown): string {
  return typeof name === "string" ? name.replace(/[\s\u3000]+/gu, "") : "";
}

/** 旧方案按 day 编号分组的带 ID 景点，以及全部旧 ID。 */
function indexPrevious(previous: Json): { byDay: Map<number, OldSpot[]>; allIds: Set<string> } {
  const byDay = new Map<number, OldSpot[]>();
  const allIds = new Set<string>();
  for (const day of daysOf(previous)) {
    const list = byDay.get(Number(day.day)) ?? [];
    for (const spot of spotsOf(day)) {
      if (!isRecord(spot) || !isItinerarySpotId(spot.spotId)) continue;
      allIds.add(spot.spotId);
      list.push({ id: spot.spotId, exact: itinerarySpotExactName(spot.name), key: itinerarySpotKey(spot.name), poiId: positivePoiId(spot) });
    }
    byDay.set(Number(day.day), list);
  }
  return { byDay, allIds };
}

/**
 * 返回 next 的深拷贝，并按以下顺序写好 spots[].spotId（同一份新方案内一个 ID 只用一次）：
 *   a. 已带 spotId、旧方案存在且未被占用 -> 保留（可跨天）；
 *   b. 同天同名的旧景点，按出现顺序一对一继承。分两轮：先整天按去空白原名精确匹配，
 *      再对剩下的按名称键匹配。否则「X」与「X（夜景）」同天并存时重排，会按名称键互换 ID；
 *   c. 同天、poiId 为正整数且相同的旧景点，一对一继承；
 *   d. 否则生成新 ID。
 * 每条规则都对所有景点整体处理一遍再进入下一条，避免前面的景点按较弱规则抢走后面景点
 * 按较强规则应得的 ID。不修改入参。
 */
export function inheritItinerarySpotIds(previous: Json, next: Json): Json {
  const result = structuredClone(next);
  const { byDay, allIds } = indexPrevious(previous);
  const taken = new Set<string>();
  const pending: Array<{ spot: Json; day: number }> = [];

  for (const day of daysOf(result)) {
    for (const spot of spotsOf(day)) {
      if (!isRecord(spot)) continue;
      const explicit = spot.spotId;
      if (isItinerarySpotId(explicit) && allIds.has(explicit) && !taken.has(explicit)) taken.add(explicit);
      else pending.push({ spot, day: Number(day.day) });
    }
  }

  const rules: Array<(spot: Json, old: OldSpot) => boolean> = [
    (spot, old) => Boolean(old.exact) && old.exact === itinerarySpotExactName(spot.name),
    (spot, old) => Boolean(old.key) && old.key === itinerarySpotKey(spot.name),
    (spot, old) => old.poiId !== undefined && old.poiId === positivePoiId(spot),
  ];
  let unresolved = pending;
  for (const rule of rules) {
    unresolved = unresolved.filter(({ spot, day }) => {
      const hit = (byDay.get(day) ?? []).find((old) => !taken.has(old.id) && rule(spot, old));
      if (!hit) return true;
      taken.add(hit.id);
      spot.spotId = hit.id;
      return false;
    });
  }
  for (const { spot } of unresolved) {
    const id = freshId(taken);
    taken.add(id);
    spot.spotId = id;
  }
  return result;
}

/**
 * 只给缺失 / 非法 / 方案内重复的景点补新 ID，已有合法且唯一的 ID 不动。
 * 没有任何需要补的景点时返回原对象引用。
 */
export function ensureItinerarySpotIds(product: Json): Json {
  const seen = new Set<string>();
  let needsFix = false;
  for (const day of daysOf(product)) {
    for (const spot of spotsOf(day)) {
      if (!isRecord(spot)) continue;
      if (isItinerarySpotId(spot.spotId) && !seen.has(spot.spotId)) seen.add(spot.spotId);
      else needsFix = true;
    }
  }
  if (!needsFix) return product;

  const result = structuredClone(product);
  const used = new Set<string>();
  for (const day of daysOf(result)) {
    for (const spot of spotsOf(day)) {
      if (!isRecord(spot)) continue;
      if (isItinerarySpotId(spot.spotId) && !used.has(spot.spotId)) used.add(spot.spotId);
      else delete spot.spotId;
    }
  }
  for (const day of daysOf(result)) {
    for (const spot of spotsOf(day)) {
      if (!isRecord(spot) || "spotId" in spot) continue;
      const id = freshId(used);
      used.add(id);
      spot.spotId = id;
    }
  }
  return result;
}

export function findItinerarySpot(
  product: Json,
  spotId: string,
): { dayIndex: number; spotIndex: number; spot: Json } | undefined {
  const itinerary = Array.isArray(product.itinerary) ? product.itinerary : [];
  for (let dayIndex = 0; dayIndex < itinerary.length; dayIndex += 1) {
    const day = itinerary[dayIndex];
    if (!isRecord(day)) continue;
    const spots = spotsOf(day);
    for (let spotIndex = 0; spotIndex < spots.length; spotIndex += 1) {
      const spot = spots[spotIndex];
      if (isRecord(spot) && spot.spotId === spotId) return { dayIndex, spotIndex, spot };
    }
  }
  return undefined;
}

/**
 * 返回行程的副本，并删掉每个对象景点的 spotId；不修改入参。
 * 审批指纹与录入阶段指纹计算前使用：补 ID 不是操作员的选择，不能让既有审批或阶段失效。
 */
export function stripItinerarySpotIds(itinerary: unknown[]): unknown[] {
  const copy = structuredClone(itinerary);
  for (const day of copy) {
    if (!isRecord(day) || !Array.isArray(day.spots)) continue;
    for (const spot of day.spots) {
      if (isRecord(spot)) delete spot.spotId;
    }
  }
  return copy;
}
