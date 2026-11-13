/**
 * 生成写入时继承运营人工设定的行程条目类型
 * ======================================
 *
 * 每日行程模块会被「继续执行 / 重跑 / 资源回写」反复重建：新值来自模型或确定性
 * 投影，天然只认识「景点」，于是把运营手动标成「自由活动 / 其他」的条目改回
 * 景点，POI 门禁随即重新把该条目列为必须核查，形成「改了又回去」的循环。
 *
 * 本模块在统一写入口内按人工凭证还原类型：
 *   1. `manualReview.itinerarySpotKinds`（受控人工 IPC 写入）优先；
 *   2. 历史数据没有该凭证时，退回「核查任务里带 `[itinerary-kind:no-poi]`
 *      证据」的条目名，兼容本次事故之前已经产生的人工分类；
 *   3. 新值已经带完整 POI 绑定时视为更强的核验事实，不覆盖。
 *
 * 纯函数，不改入参；由 ProductMutationService 在 source 非 user 时调用。
 */

import { itinerarySpotKey, isItinerarySpotId } from "./itinerary-spot-identity.js";
import { hasCompletePoi } from "./itinerary-activity-kind.js";
import { poiResearchTaskNames } from "./poi-research-tasks.js";
import { operatorItinerarySpotKinds, type OperatorItinerarySpotKind } from "./operator-itinerary-kinds.js";

type Json = Record<string, unknown>;

type ResearchTaskLike = {
  type?: unknown;
  label?: unknown;
  evidence?: ReadonlyArray<{ accepted?: unknown; title?: unknown }>;
};

const NO_POI_EVIDENCE_MARKER = "[itinerary-kind:no-poi]";

export function preserveOperatorActivityKinds(
  current: Json,
  incoming: Json,
  researchTasks: readonly ResearchTaskLike[] = [],
): Json {
  const next = structuredClone(incoming) as Json;
  const records = operatorItinerarySpotKinds(current);
  const legacyKeys = legacyNonPoiKeys(researchTasks);
  const currentDays = indexDays(current);
  const nextDays = Array.isArray(next.itinerary) ? next.itinerary.filter(isRecord) : [];
  const settled: OperatorItinerarySpotKind[] = [];
  for (const day of nextDays) {
    const dayNumber = Number(day.day);
    const currentDay = currentDays.get(dayNumber);
    if (!Number.isInteger(dayNumber) || dayNumber <= 0 || !currentDay) continue;
    const spots = Array.isArray(day.spots) ? day.spots.filter(isRecord) : [];
    for (const spot of spots) {
      const name = text(spot.name) || text(spot.poiName);
      const spotId = isItinerarySpotId(spot.spotId) ? spot.spotId : undefined;
      const record = records.find((entry) => entry.day === dayNumber
        && ((spotId && entry.spotId === spotId) || Boolean(itinerarySpotKey(name)) && itinerarySpotKey(entry.name) === itinerarySpotKey(name)));
      if (record) {
        applyOperatorKind(spot, record);
        continue;
      }
      const key = itinerarySpotKey(name);
      if (!key || !legacyKeys.has(key)) continue;
      if (applyLegacyNonPoi(spot)) {
        // 把历史证据固化成人工凭证，之后即使核查任务被重建也不会再丢。
        settled.push({ day: dayNumber, name, kind: "other", setAt: new Date().toISOString(),
          ...(spotId ? { spotId } : {}) });
      }
    }
    // 被运营删掉的条目由 preserveItineraryRemovals 处理；这里不重排 spots。
    day.spots = spots;
  }
  restoreRecords(next, [...records, ...settled.filter((entry) => !records.some((record) =>
    record.day === entry.day && itinerarySpotKey(record.name) === itinerarySpotKey(entry.name)))]);
  return next;
}

/** 人工记录优先于新值：运营改回景点也以凭证为准，直到下一次人工操作覆盖它。 */
function applyOperatorKind(spot: Json, record: OperatorItinerarySpotKind): void {
  if (record.kind === "attraction") {
    if (spot.kind === "attraction") return;
    spot.kind = "attraction";
    clearPoiBinding(spot);
    return;
  }
  // 已带完整 POI 的条目是资源核验后的事实，不由历史分类凭证反向清空。
  if (hasCompletePoi(spot)) return;
  if (spot.kind === record.kind && !text(spot.poiName) && !positive(spot.poiId)) return;
  spot.kind = record.kind;
  spot.relation = "and";
  clearPoiBinding(spot);
}

/** 历史兜底只做「不该被当景点」这一件事，不猜测 free 与 other 的区别。 */
function applyLegacyNonPoi(spot: Json): boolean {
  if (spot.kind !== "attraction" || hasCompletePoi(spot)) return false;
  spot.kind = "other";
  clearPoiBinding(spot);
  return true;
}

function clearPoiBinding(spot: Json): void {
  spot.poiId = null;
  spot.poiName = null;
  for (const field of ["poiData", "poiType", "ticketType", "images", "latitude", "longitude"] as const) {
    delete spot[field];
  }
}

function restoreRecords(next: Json, records: readonly OperatorItinerarySpotKind[]): void {
  const manualReview = isRecord(next.manualReview) ? { ...next.manualReview } : {};
  if (records.length) manualReview.itinerarySpotKinds = structuredClone(records);
  else delete manualReview.itinerarySpotKinds;
  if (Object.keys(manualReview).length) next.manualReview = manualReview;
  else delete next.manualReview;
}

/** 历史分类凭证：核查任务的证据里带 no-poi 标记（任务状态可能已被重新排队）。 */
function legacyNonPoiKeys(tasks: readonly ResearchTaskLike[]): Set<string> {
  const keys = new Set<string>();
  for (const task of tasks) {
    const label = text(task.label);
    const type = text(task.type);
    if (!label || (type !== "vbk" && type !== "web")) continue;
    const evidenced = (task.evidence ?? []).some((item) => {
      return item?.accepted === true && text(item.title).includes(NO_POI_EVIDENCE_MARKER);
    });
    if (!evidenced) continue;
    for (const name of poiResearchTaskNames(label, type as "vbk" | "web")) {
      const key = itinerarySpotKey(name);
      if (key) keys.add(key);
    }
  }
  return keys;
}

function indexDays(product: Json): Map<number, Json> {
  const days = new Map<number, Json>();
  const itinerary = Array.isArray(product.itinerary) ? product.itinerary : [];
  for (const value of itinerary) {
    const day = isRecord(value) ? value : undefined;
    const dayNumber = Number(day?.day);
    if (day && Number.isInteger(dayNumber) && dayNumber > 0) days.set(dayNumber, day);
  }
  return days;
}

function positive(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Json {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
