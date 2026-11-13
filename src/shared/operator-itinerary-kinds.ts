/**
 * 运营人工设定的行程条目类型凭证
 * ============================
 *
 * `spot.kind` 是生成与投影阶段会重建的字段：运营在界面上把某个条目从「景点」
 * 改成「自由活动 / 其他」后，只要再点一次「继续执行」，每日行程模块重新生成，
 * 该条目的类型就会被写回「景点」，随后 POI 门禁又把它当成必须绑定 POI 的景点
 * 拦住。运营看到的现象就是「我手动改成的其他又被改回景点，然后说有问题」。
 *
 * 因此人工类型必须与删除凭证一样，另存为 `manualReview` 下的独立凭证：
 *   - 人工改成 free / other 时记录；
 *   - 人工改回 attraction 也记录（显式撤销，避免旧凭证永远压住新决定）；
 *   - 生成 / 投影 / 资源写入时只继承该凭证，不自行改写它。
 *
 * 只认本模块（由受控人工 IPC 调用）写入的记录：原始 JSON 与 AI patch 不能伪造。
 */

import { isItinerarySpotId, itinerarySpotKey } from "./itinerary-spot-identity.js";

type Json = Record<string, unknown>;

export type OperatorItinerarySpotKindValue = "attraction" | "free" | "other";

export interface OperatorItinerarySpotKind {
  day: number;
  name: string;
  kind: OperatorItinerarySpotKindValue;
  setAt: string;
  /** 设置时的稳定景点身份；旧记录可能没有。 */
  spotId?: string;
}

const MANUAL_REVIEW_KEY = "itinerarySpotKinds";

/** 读取人工类型凭证；结构不合法或缺失时返回空数组。 */
export function operatorItinerarySpotKinds(product: Json): OperatorItinerarySpotKind[] {
  const manualReview = record(product.manualReview);
  const raw = manualReview?.[MANUAL_REVIEW_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): OperatorItinerarySpotKind[] => {
    const entry = record(item);
    const day = Number(entry?.day);
    const name = text(entry?.name);
    const kind = entry?.kind;
    if (!Number.isInteger(day) || day <= 0 || !name) return [];
    if (kind !== "attraction" && kind !== "free" && kind !== "other") return [];
    return [{
      day,
      name,
      kind,
      setAt: text(entry?.setAt) || new Date(0).toISOString(),
      ...(isItinerarySpotId(entry?.spotId) ? { spotId: entry!.spotId as string } : {}),
    }];
  });
}

/** 写入或覆盖一条人工类型凭证（同一天、同一 spotId / 名称只保留最新一条）。 */
export function recordOperatorItinerarySpotKind(
  product: Json,
  input: { day: number; name: string; kind: OperatorItinerarySpotKindValue; setAt: string; spotId?: string },
): void {
  const name = input.name.trim();
  if (!Number.isInteger(input.day) || input.day <= 0 || !name) return;
  const current = operatorItinerarySpotKinds(product);
  const next = current.filter((entry) => !sameTarget(entry, input.day, name, input.spotId));
  next.push({
    day: input.day,
    name,
    kind: input.kind,
    setAt: input.setAt,
    ...(isItinerarySpotId(input.spotId) ? { spotId: input.spotId } : {}),
  });
  const manualReview = record(product.manualReview) ?? {};
  manualReview[MANUAL_REVIEW_KEY] = next;
  product.manualReview = manualReview;
}

/** 查找某天某条目的人工类型；spotId 命中优先，其次按名称键。 */
export function findOperatorItinerarySpotKind(
  product: Json,
  day: number,
  name: string,
  spotId?: string,
): OperatorItinerarySpotKind | undefined {
  const entries = operatorItinerarySpotKinds(product).filter((entry) => entry.day === day);
  if (isItinerarySpotId(spotId)) {
    const byId = entries.find((entry) => entry.spotId === spotId);
    if (byId) return byId;
  }
  const key = itinerarySpotKey(name);
  return key ? entries.find((entry) => itinerarySpotKey(entry.name) === key) : undefined;
}

/**
 * 原始 JSON 保存以操作员看到的值为准：把凭证同步成 JSON 里的实际类型。
 * 条目暂时消失时保留凭证（等它重新出现），只有类型确实变化才重写。
 */
export function reconcileOperatorItineraryKindsFromProduct(product: Json, setAt = new Date().toISOString()): boolean {
  const records = operatorItinerarySpotKinds(product);
  if (!records.length) return false;
  const spotsByDay = new Map<number, Json[]>();
  for (const value of Array.isArray(product.itinerary) ? product.itinerary : []) {
    const day = record(value);
    const dayNumber = Number(day?.day);
    if (!day || !Number.isInteger(dayNumber) || dayNumber <= 0) continue;
    const spots: Json[] = [];
    for (const item of Array.isArray(day.spots) ? day.spots : []) {
      const spot = record(item);
      if (spot) spots.push(spot);
    }
    spotsByDay.set(dayNumber, spots);
  }
  let changed = false;
  const next = records.map((entry) => {
    const spots = spotsByDay.get(entry.day) ?? [];
    const spot = spots.find((candidate) => isItinerarySpotId(entry.spotId) && candidate.spotId === entry.spotId)
      ?? spots.find((candidate) => Boolean(itinerarySpotKey(candidate.name)) && itinerarySpotKey(candidate.name) === itinerarySpotKey(entry.name));
    if (!spot) return entry;
    const kind = spot.kind === "free" || spot.kind === "other" ? spot.kind : "attraction";
    if (kind === entry.kind) return entry;
    changed = true;
    return { ...entry, kind, setAt };
  });
  if (!changed) return false;
  const manualReview = record(product.manualReview) ?? {};
  manualReview[MANUAL_REVIEW_KEY] = next;
  product.manualReview = manualReview;
  return true;
}

function sameTarget(entry: OperatorItinerarySpotKind, day: number, name: string, spotId?: string): boolean {
  if (entry.day !== day) return false;
  if (isItinerarySpotId(spotId) && isItinerarySpotId(entry.spotId)) return entry.spotId === spotId;
  const key = itinerarySpotKey(name);
  return Boolean(key) && (entry.name.trim() === name.trim() || itinerarySpotKey(entry.name) === key);
}

function record(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
