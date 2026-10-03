import type Database from "better-sqlite3";
import type { ProductExecutionTime } from "../../shared/product-execution-time.js";
import { ensureProductExecutionTime } from "./product-execution-clock.js";

interface ClockRow {
  id: string;
  elapsed_ms: number | null;
  active_since: number | null;
  historical_incomplete: number | null;
}

const SQLITE_VARIABLE_CHUNK = 500;

/**
 * Read local telemetry for known products in bounded SQL batches. Older
 * products without a clock row are reconstructed once, then persisted.
 */
export function readProductExecutionTimes(
  db: Database.Database,
  ids: readonly string[],
  now = Date.now(),
): Record<string, ProductExecutionTime> {
  const uniqueIds = [...new Set(ids)];
  const rows = readRows(db, uniqueIds);
  const missing = uniqueIds.filter((id) => rows.get(id)?.elapsed_ms === null);
  for (const id of missing) ensureProductExecutionTime(db, id);
  if (missing.length) {
    for (const [id, row] of readRows(db, missing)) rows.set(id, row);
  }
  return Object.fromEntries([...rows].flatMap(([id, row]) => {
    if (row.elapsed_ms === null || row.historical_incomplete === null) return [];
    const activeFor = row.active_since === null ? 0 : Math.max(0, Math.min(now - row.active_since, 2500));
    return [[id, {
      elapsedMs: row.elapsed_ms + activeFor,
      running: row.active_since !== null && now - row.active_since <= 2500,
      historicalIncomplete: Boolean(row.historical_incomplete),
    }]];
  }));
}

function readRows(db: Database.Database, ids: readonly string[]): Map<string, ClockRow> {
  const rows = new Map<string, ClockRow>();
  for (let index = 0; index < ids.length; index += SQLITE_VARIABLE_CHUNK) {
    const batch = ids.slice(index, index + SQLITE_VARIABLE_CHUNK);
    if (!batch.length) continue;
    const placeholders = batch.map(() => "?").join(",");
    const result = db.prepare(`
      SELECT products.id, clock.elapsed_ms, clock.active_since, clock.historical_incomplete
      FROM products
      LEFT JOIN product_execution_time AS clock ON clock.local_product_id=products.id
      WHERE products.id IN (${placeholders})
    `).all(...batch) as ClockRow[];
    for (const row of result) rows.set(row.id, row);
  }
  return rows;
}
