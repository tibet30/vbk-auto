import type Database from "better-sqlite3";
import type { ProductSummary } from "../../../../shared/contracts.js";
import { readActiveCoverFallback } from "../../../../shared/cover-fallback.js";
import { readProductExecutionTime } from "../../../operations/product-execution-clock.js";

/**
 * 产品列表（按 updated_at 倒序）。
 */
export function listProducts(db: Database.Database): ProductSummary[] {
  return (db.prepare("SELECT id,name,status,product_id,product_json,updated_at FROM products ORDER BY updated_at DESC").all() as Array<Record<string, string>>)
    .map(row => productSummaryFromRow(db, row));
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
  const items = (db.prepare(
    "SELECT id,name,status,product_id,product_json,updated_at FROM products ORDER BY updated_at DESC LIMIT ? OFFSET ?",
  ).all(pageSize, offset) as Array<Record<string, string>>)
    .map(row => productSummaryFromRow(db, row));
  return { items, total };
}

function productSummaryFromRow(db: Database.Database, row: Record<string, string>): ProductSummary {
  let coverNeedsReplacement = false;
  try {
    coverNeedsReplacement = Boolean(readActiveCoverFallback(JSON.parse(row.product_json) as Record<string, unknown>));
  } catch {
    // A malformed historical product remains visible in the list.
  }
  return {
    id: row.id, name: row.name, status: row.status as ProductSummary["status"],
    productId: row.product_id || undefined, updatedAt: row.updated_at,
    executionTime: readProductExecutionTime(db, row.id),
    ...(coverNeedsReplacement ? { coverNeedsReplacement } : {}),
  };
}
