import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ResearchTask } from "../../../../shared/contracts.js";
import { poiResearchTaskLabel, poiResearchTaskNames } from "../../../../shared/poi-research-tasks.js";
import { isKnownPoiNameAlias } from "../../../../shared/poi-name-aliases.js";
import { hasAmbiguousManualPoiSelection } from "../../../../shared/research-task-satisfaction.js";
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
  const exact = mappings.filter((mapping) => persistedMappingExists(product, mapping));
  const collapsedAliases = mappings.filter((mapping) => !exact.includes(mapping)
    && persistedAliasReceiptExists(product, mapping));
  const persisted = [...exact, ...collapsedAliases];
  if (!persisted.length) return { updated: 0, taskIds: [] };

  const allRows = db.prepare(`SELECT id,label,type,state,detail,evidence_json FROM research_tasks
    WHERE local_product_id=? AND type='vbk'`).all(localProductId) as TaskRow[];
  const rows = allRows.filter((row) => !["confirmed", "resolved"].includes(row.state));
  const matched = rows.filter((task) => (hasAmbiguousManualPoiSelection(task)
      || collapsedAliases.some((mapping) => poiResearchTaskNames(task.label, task.type)
        .some((name) => sameName(name, mapping.spotName))))
    && poiResearchTaskNames(task.label, task.type).every((name) => persisted.some((mapping) => sameName(name, mapping.spotName))));
  const update = db.prepare(`UPDATE research_tasks SET state='confirmed', status='succeeded', detail=?, evidence_json=?
    WHERE id=? AND local_product_id=? AND state NOT IN ('confirmed','resolved')`);
  const taskIds: string[] = [];
  for (const task of matched) {
    const taskMappings = persisted.filter((mapping) => poiResearchTaskNames(task.label, task.type)
      .some((name) => sameName(name, mapping.spotName)));
    const evidence = parseEvidence(task.evidence_json);
    evidence.push({
      id: randomUUID(),
      title: `${VERIFIED_POI_EVIDENCE_MARKER} ${taskMappings.map(mapping =>
        `第${mapping.day}天 ${mapping.spotName} -> ${mapping.poiName} (${mapping.poiId})`).join("；")}`,
      source: "vbk",
      retrievedAt: now(),
      accepted: true,
    });
    if (update.run(SAVED_POI_DETAIL, JSON.stringify(evidence), task.id, localProductId).changes > 0) taskIds.push(task.id);
  }
  for (const mapping of collapsedAliases) {
    const label = poiResearchTaskLabel(mapping.spotName);
    if (allRows.some((task) => task.label === label)) continue;
    const id = randomUUID();
    const evidence = [{
      id: randomUUID(),
      title: verifiedEvidenceTitle(mapping),
      source: "vbk",
      retrievedAt: now(),
      accepted: true,
    }];
    db.prepare("INSERT INTO research_tasks VALUES(?,?,?,?,?,?,?,?)")
      .run(id, localProductId, label, "vbk", "succeeded", "confirmed", SAVED_POI_DETAIL, JSON.stringify(evidence));
    taskIds.push(id);
  }
  if (taskIds.length) touchProduct(db, localProductId);
  return { updated: taskIds.length, taskIds };
}

function verifiedEvidenceTitle(mapping: VerifiedPoiMapping): string {
  return `${VERIFIED_POI_EVIDENCE_MARKER} 第${mapping.day}天 ${mapping.spotName} -> ${mapping.poiName} (${mapping.poiId})`;
}

function persistedMappingExists(product: Record<string, unknown>, mapping: VerifiedPoiMapping): boolean {
  if (!Array.isArray(product.itinerary)) return false;
  return product.itinerary.some((day) => isRecord(day) && Number(day.day) === mapping.day
    && Array.isArray(day.spots) && day.spots.some((spot) => isRecord(spot)
      && sameName(String(spot.name ?? ""), mapping.spotName)
      && spot.poiId === mapping.poiId
      && sameName(String(spot.poiName ?? ""), mapping.poiName)));
}

function persistedAliasReceiptExists(
  product: Record<string, unknown>,
  mapping: VerifiedPoiMapping,
): boolean {
  if (!Array.isArray(product.itinerary)) return false;
  return product.itinerary.some((day) => isRecord(day) && Number(day.day) === mapping.day
    && Array.isArray(day.spots) && day.spots.some((spot) => isRecord(spot)
      && spot.poiId === mapping.poiId
      && sameName(String(spot.poiName ?? ""), mapping.poiName)
      && isKnownPoiNameAlias(String(spot.name ?? ""), mapping.spotName)));
}

function parseEvidence(value: string): unknown[] {
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}
function sameName(left: string, right: string): boolean { return left.replace(/\s+/gu, "") === right.replace(/\s+/gu, ""); }
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
