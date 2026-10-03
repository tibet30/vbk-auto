import type Database from "better-sqlite3";
import type { ProductSummary } from "../../../../shared/contracts.js";
import { now } from "./types.js";

/**
 * 写入产品 product_json，可选更新 status。直接覆盖整个 product 字段。
 */
export function updateProduct(
  db: Database.Database,
  id: string,
  product: Record<string, unknown>,
  status?: ProductSummary["status"],
  expectedVersion?: number,
) {
  const write = db.transaction(() => {
    const basicInfo = product.basicInfo && typeof product.basicInfo === "object" && !Array.isArray(product.basicInfo)
      ? product.basicInfo as Record<string, unknown>
      : undefined;
    const nextName = typeof basicInfo?.supplierProductName === "string"
      ? basicInfo.supplierProductName.trim()
      : "";
    const current = db.prepare("SELECT product_json_version FROM products WHERE id=?").get(id) as { product_json_version?: number } | undefined;
    if (!current) throw new Error("产品不存在");
    const expected = expectedVersion ?? (Number(current.product_json_version ?? 0) || 0);
    const result = db.prepare("UPDATE products SET product_json=?, name=CASE WHEN ?<>'' THEN ? ELSE name END, status=COALESCE(?,status), updated_at=?, product_json_version=product_json_version+1 WHERE id=? AND product_json_version=?")
      .run(JSON.stringify(product), nextName, nextName, status || null, now(), id, expected);
    if (result.changes === 0) throw new Error("产品内容已变更，请刷新后重试。");
    if (nextName) {
      db.prepare("UPDATE workflow_tasks SET product_name=? WHERE local_product_id=? AND product_name<>?")
        .run(nextName, id, nextName);
    }
  });
  write();
}

