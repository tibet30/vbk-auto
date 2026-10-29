import type Database from "better-sqlite3";
import type { Migration } from "./migrations.js";
import { ensureItinerarySpotIds } from "../../../../shared/itinerary-spot-identity.js";

/**
 * 给存量产品的行程景点补齐稳定 spotId。
 *
 * - 行程留在 products.product_json（拆分后的 plan）里，只改这一列；
 * - 不递增 product_json_version / plan_version：补 ID 不是内容变更，审批指纹也会剥掉 spotId；
 * - 无法解析的行原样跳过，脏数据不能让应用启动失败，后续正常保存时再补 ID。
 */
export const itinerarySpotIdMigration: Migration = {
  id: "0019_itinerary_spot_id",
  statements: [],
  migrate(db: Database.Database) {
    const rows = db.prepare("SELECT id,product_json FROM products").all() as Array<{ id: string; product_json: string }>;
    const update = db.prepare("UPDATE products SET product_json=? WHERE id=?");
    for (const row of rows) {
      let plan: unknown;
      try {
        plan = JSON.parse(row.product_json);
      } catch {
        continue;
      }
      if (!plan || typeof plan !== "object" || Array.isArray(plan)) continue;
      const filled = ensureItinerarySpotIds(plan as Record<string, unknown>);
      if (filled !== plan) update.run(JSON.stringify(filled), row.id);
    }
  },
};
