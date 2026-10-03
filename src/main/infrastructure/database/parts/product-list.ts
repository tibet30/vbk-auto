import type Database from "better-sqlite3";
import type { ProductSummary } from "../../../../shared/contracts.js";
import { readActiveCoverFallback } from "../../../../shared/cover-fallback.js";
import { readProductExecutionTimes } from "../../../operations/product-execution-time-read.js";

/**
 * 产品列表（按 updated_at 倒序）。
 */
export function listProducts(db: Database.Database): ProductSummary[] {
  const rows = db.prepare("SELECT id,name,status,product_id,product_json,updated_at FROM products ORDER BY updated_at DESC").all() as Array<Record<string, string>>;
  return productSummariesFromRows(db, rows);
}

/** 分页产品列表结果。 */
export interface ProductListPage {
  items: ProductSummary[];
  total: number;
}

/**
 * 分页产品列表（按 updated_at 倒序）。
 * page 从 1 起；pageSize 默认 10。
 */
export function listProductsPaginated(db: Database.Database, page: number, pageSize = 10): ProductListPage {
  const total = (db.prepare("SELECT COUNT(*) AS n FROM products").get() as { n: number }).n;
  const offset = Math.max(0, (page - 1) * pageSize);
  const rows = db.prepare(
    "SELECT id,name,status,product_id,product_json,updated_at FROM products ORDER BY updated_at DESC LIMIT ? OFFSET ?",
  ).all(pageSize, offset) as Array<Record<string, string>>;
  const items = productSummariesFromRows(db, rows);
  return { items, total };
}

function productSummariesFromRows(db: Database.Database, rows: Array<Record<string, string>>): ProductSummary[] {
  const executionTimes = readProductExecutionTimes(db, rows.map((row) => row.id));
  return rows.map((row) => productSummaryFromRow(row, executionTimes[row.id]));
}

function productSummaryFromRow(row: Record<string, string>, executionTime: ProductSummary["executionTime"]): ProductSummary {
  let coverNeedsReplacement = false;
  try {
    coverNeedsReplacement = Boolean(readActiveCoverFallback(JSON.parse(row.product_json) as Record<string, unknown>));
  } catch {
    // A malformed historical product remains visible in the list.
  }
  return {
    id: row.id, name: row.name, status: row.status as ProductSummary["status"],
    productId: row.product_id || undefined, updatedAt: row.updated_at,
    executionTime,
    ...(coverNeedsReplacement ? { coverNeedsReplacement } : {}),
  };
}
