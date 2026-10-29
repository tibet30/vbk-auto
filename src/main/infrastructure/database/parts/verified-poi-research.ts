import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Evidence, ResearchTask } from "../../../../shared/contracts.js";
import { poiResearchTaskNames } from "../../../../shared/poi-research-tasks.js";
import { isItinerarySpotId, itinerarySpotKey } from "../../../../shared/itinerary-spot-identity.js";
import { hasAmbiguousManualPoiSelection, requiresCurrentPoiVerification } from "../../../../shared/research-task-satisfaction.js";
import type { VerifiedPoiMapping } from "../../../planning/types.js";
import { touchProduct } from "./products.js";
import { now } from "./types.js";

export const VERIFIED_POI_EVIDENCE_MARKER = "[itinerary-poi:verified]";
const SAVED_POI_DETAIL = "当前行程已保存有效的 VBK POI 映射。";

interface TaskRow {
  id: string;
  label: string;
  type: ResearchTask["type"];
  state: string;
  detail: string | null;
  evidence_json: string;
}

/** A later lookup failure must not invalidate a controlled receipt while the
 * exact saved day/name/POI mapping is still present in the current product. */
export function hasCurrentVerifiedPoiEvidence(
  product: Record<string, unknown>,
  task: Pick<TaskRow, "label" | "type" | "evidence_json">,
): boolean {
  const names = poiResearchTaskNames(task.label, task.type);
  if (!names.length) return false;
  const receipts = verifiedMappingsFromEvidence(task.evidence_json);
  return receipts.length > 0
    && names.every((name) => everyCurrentSlotVerified(product, name, receipts));
}

/** Repairs rows reopened by the historic duplicate-task path. Evidence is
 * preserved; only a receipt that still matches the current product can close. */
export function restoreCurrentVerifiedPoiResearchTasks(
  db: Database.Database,
  localProductId: string,
): { updated: number; taskIds: string[] } {
  const productRow = db.prepare("SELECT product_json FROM products WHERE id=?").get(localProductId) as { product_json?: string } | undefined;
  if (!productRow?.product_json) return { updated: 0, taskIds: [] };
  let product: Record<string, unknown>;
  try { product = JSON.parse(productRow.product_json) as Record<string, unknown>; } catch { return { updated: 0, taskIds: [] }; }
  const rows = db.prepare(`SELECT id,label,type,state,detail,evidence_json FROM research_tasks
    WHERE local_product_id=? AND type='vbk' AND state NOT IN ('confirmed','resolved')`).all(localProductId) as TaskRow[];
  const matched = rows.filter((task) => hasCurrentVerifiedPoiEvidence(product, task));
  const update = db.prepare(`UPDATE research_tasks SET state='confirmed', status='succeeded', detail=?
    WHERE id=? AND local_product_id=? AND state NOT IN ('confirmed','resolved')`);
  const taskIds = matched.filter((task) => update.run(SAVED_POI_DETAIL, task.id, localProductId).changes > 0)
    .map((task) => task.id);
  if (taskIds.length) touchProduct(db, localProductId);
  return { updated: taskIds.length, taskIds };
}

/**
 * Settle an ambiguity task only from the controlled POI resolver receipt.
 * A same-name/positive-ID product JSON write is deliberately insufficient.
 */
export function confirmVerifiedPoiResearchTasks(
  db: Database.Database,
  localProductId: string,
  mappings: readonly VerifiedPoiMapping[],
): { updated: number; taskIds: string[] } {
  const productRow = db.prepare("SELECT product_json FROM products WHERE id=?").get(localProductId) as { product_json?: string } | undefined;
  if (!productRow?.product_json || !mappings.length) return { updated: 0, taskIds: [] };
  let product: Record<string, unknown>;
  try { product = JSON.parse(productRow.product_json) as Record<string, unknown>; } catch { return { updated: 0, taskIds: [] }; }
  const persisted = mappings.filter(mapping => persistedMappingExists(product, mapping));
  if (!persisted.length) return { updated: 0, taskIds: [] };

  const allRows = db.prepare(`SELECT id,label,type,state,detail,evidence_json FROM research_tasks
    WHERE local_product_id=? AND type='vbk'`).all(localProductId) as TaskRow[];
  const rows = allRows.filter((row) => !["confirmed", "resolved"].includes(row.state));
  const matched = rows.filter((task) => (hasAmbiguousManualPoiSelection(task)
      || requiresCurrentPoiVerification(task))
    && poiResearchTaskNames(task.label, task.type).every((name) => everyCurrentSlotVerified(product, name, persisted)));
  const update = db.prepare(`UPDATE research_tasks SET state='confirmed', status='succeeded', detail=?, evidence_json=?
    WHERE id=? AND local_product_id=? AND state NOT IN ('confirmed','resolved')`);
  const taskIds: string[] = [];
  for (const task of matched) {
    const taskMappings = persisted.filter((mapping) => poiResearchTaskNames(task.label, task.type)
      .some((name) => sameName(name, mapping.spotName)));
    const evidence = parseEvidence(task.evidence_json);
    evidence.push({
      id: randomUUID(),
      // 文本形式保留给旧读取方与远端同步；结构化 poiMappings 是新的首选来源。
      title: `${VERIFIED_POI_EVIDENCE_MARKER} ${taskMappings.map(mapping =>
        `第${mapping.day}天 ${mapping.spotName} -> ${mapping.poiName} (${mapping.poiId})`).join("；")}`,
      poiMappings: taskMappings.map(receiptMapping),
      source: "vbk",
      retrievedAt: now(),
      accepted: true,
    });
    if (update.run(SAVED_POI_DETAIL, JSON.stringify(evidence), task.id, localProductId).changes > 0) taskIds.push(task.id);
  }
  if (taskIds.length) touchProduct(db, localProductId);
  return { updated: taskIds.length, taskIds };
}

function persistedMappingExists(product: Record<string, unknown>, mapping: VerifiedPoiMapping): boolean {
  return currentSlots(product).some(({ day, spot }) => slotMatches(mapping, day, spot));
}

/** One current receipt cannot settle another day's same-named pending verification.
 * 改名后任务标签仍是旧名：凭证 spotName 与标签同名时，其 spotId 指向的槽位也归入本任务。 */
function everyCurrentSlotVerified(product: Record<string, unknown>, name: string, mappings: readonly VerifiedPoiMapping[]): boolean {
  const key = itinerarySpotKey(name);
  if (!key) return false;
  const labelledIds = new Set(mappings.filter((mapping) => itinerarySpotKey(mapping.spotName) === key && isItinerarySpotId(mapping.spotId))
    .map((mapping) => mapping.spotId));
  const slots = currentSlots(product).filter(({ spot }) => itinerarySpotKey(spot.name) === key
    || (isItinerarySpotId(spot.spotId) && labelledIds.has(spot.spotId)));
  const receipts = [...mappings];
  return slots.length > 0 && slots.every(({ day, spot }) => {
    const index = receipts.findIndex((mapping) => slotMatches(mapping, day, spot));
    if (index < 0) return false;
    receipts.splice(index, 1);
    return true;
  });
}

function currentSlots(product: Record<string, unknown>): Array<{ day: number; spot: Record<string, unknown> }> {
  if (!Array.isArray(product.itinerary)) return [];
  return product.itinerary.flatMap((day) => isRecord(day) && Array.isArray(day.spots)
    ? day.spots.filter(isRecord).map((spot) => ({ day: Number(day.day), spot })) : []);
}

/** 双方都有 spotId 时按 spotId + poiId 认定同一槽位（改名不影响）；否则按天 + 名称 + POI。 */
function slotMatches(mapping: VerifiedPoiMapping, day: number, spot: Record<string, unknown>): boolean {
  if (isItinerarySpotId(mapping.spotId) && isItinerarySpotId(spot.spotId)) {
    return mapping.spotId === spot.spotId && spot.poiId === mapping.poiId;
  }
  return mapping.day === day && sameName(String(spot.name ?? ""), mapping.spotName)
    && spot.poiId === mapping.poiId && sameName(String(spot.poiName ?? ""), mapping.poiName);
}

function parseEvidence(value: string): unknown[] {
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

function verifiedMappingsFromEvidence(value: string): VerifiedPoiMapping[] {
  return parseEvidence(value).flatMap((item) => {
    if (!isRecord(item)) return [];
    if (Array.isArray(item.poiMappings)) return item.poiMappings.flatMap(structuredMapping);
    const title = typeof item.title === "string" ? item.title : "";
    if (!title.includes(VERIFIED_POI_EVIDENCE_MARKER)) return [];
    return title.slice(title.indexOf(VERIFIED_POI_EVIDENCE_MARKER) + VERIFIED_POI_EVIDENCE_MARKER.length)
      .split("；").flatMap((part) => {
        const match = /^\s*第(\d+)天\s+(.+?)\s+->\s+(.+?)\s+\((\d+)\)\s*$/u.exec(part);
        return match ? [{ day: Number(match[1]), spotName: match[2]!, poiName: match[3]!, poiId: Number(match[4]) }] : [];
      });
  });
}

/** 结构化凭证逐项校验；字段不合法的条目丢弃，不让它参与结清。 */
function structuredMapping(value: unknown): VerifiedPoiMapping[] {
  if (!isRecord(value)) return [];
  const { day, spotId, spotName, poiName, poiId } = value;
  if (typeof day !== "number" || !Number.isInteger(day) || day <= 0) return [];
  if (typeof poiId !== "number" || !Number.isInteger(poiId) || poiId <= 0) return [];
  if (typeof spotName !== "string" || !spotName.trim() || typeof poiName !== "string" || !poiName.trim()) return [];
  return [{ day, ...(isItinerarySpotId(spotId) ? { spotId } : {}), spotName, poiName, poiId }];
}

function receiptMapping(mapping: VerifiedPoiMapping): NonNullable<Evidence["poiMappings"]>[number] {
  return { day: mapping.day, ...(isItinerarySpotId(mapping.spotId) ? { spotId: mapping.spotId } : {}),
    spotName: mapping.spotName, poiName: mapping.poiName, poiId: mapping.poiId };
}

function sameName(left: string, right: string): boolean { return itinerarySpotKey(left) === itinerarySpotKey(right); }
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
