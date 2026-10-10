/**
 * 产品基础信息字段直接写入（绕过 AI 规划）：
 *   - updateBasicInfoField：运营可直接维护 AI 不允许写入的基础信息字段
 *     （例如供应商产品编号）；返回更新后的完整产品。
 *   - setProductId：更新 product_id 字段（产品壳生成后回填）。
 *   - setBasicInfoSaved：标记基本信息是否在 VBK 保存成功。
 *   - setProductLifecycle：事务化更新 product_id + status + basicInfoSaved 任一字段
 *     + touch 都是一个原子写入，便于在 status/automation 切换场景中保持一致。
 */

import type Database from "better-sqlite3";
import type { ProductSummary, ProductDetail } from "../../../../../shared/contracts.js";
import { now } from "../types.js";
import { getProduct } from "./import.js";
import { touchProduct } from "./messages.js";
import { updateProduct } from "../product-update.js";

export function updateBasicInfoField(db: Database.Database, localProductId: string, field: string, value: string): ProductDetail {
  const product = getProduct(db, localProductId);
  if (!product) throw new Error("产品不存在");
  const trimmed = value.trim();
  if (!trimmed) throw new Error("内容不能为空。");
  const productData = { ...product.product } as Record<string, unknown>;
  const basicInfo = productData.basicInfo && typeof productData.basicInfo === "object" && !Array.isArray(productData.basicInfo)
    ? { ...(productData.basicInfo as Record<string, unknown>) }
    : {};
  basicInfo[field] = trimmed;
  productData.basicInfo = basicInfo;
  updateProduct(db, localProductId, productData);
  return getProduct(db, localProductId)!;
}

/** 更新 product_id 字段（产品壳生成后回填）。 */
export function setProductId(db: Database.Database, localProductId: string, productId: string) {
  const tx = db.transaction(() => db.prepare("UPDATE products SET product_id=?,updated_at=? WHERE id=?").run(productId, now(), localProductId));
  tx();
}

/** 标记基本信息是否在 VBK 保存成功。 */
export function setBasicInfoSaved(db: Database.Database, localProductId: string, saved = true) {
  const tx = db.transaction(() => db.prepare("UPDATE products SET basic_info_saved=?,updated_at=? WHERE id=?").run(saved ? 1 : 0, now(), localProductId));
  tx();
}

/**
 * 事务化更新：product_id + status + basicInfoSaved 任一字段 + touch 都是
 * 一个原子写入，便于在 status/automation 切换场景中保持一致。
 */
export function setProductLifecycle(
  db: Database.Database,
  localProductId: string,
  updates: { productId?: string | null; status?: ProductSummary["status"]; basicInfoSaved?: boolean },
): void {
  const tx = db.transaction(() => {
    if (updates.productId !== undefined) db.prepare("UPDATE products SET product_id=?, updated_at=? WHERE id=?").run(updates.productId, now(), localProductId);
    if (updates.status !== undefined) db.prepare("UPDATE products SET status=?, updated_at=? WHERE id=?").run(updates.status, now(), localProductId);
    if (updates.basicInfoSaved !== undefined) db.prepare("UPDATE products SET basic_info_saved=?, updated_at=? WHERE id=?").run(updates.basicInfoSaved ? 1 : 0, now(), localProductId);
    touchProduct(db, localProductId);
  });
  tx();
}