import type Database from "better-sqlite3";
import type { ProductSummary } from "../../../../shared/contracts.js";
import { now } from "./types.js";
import { readProductArchitecture, writeProductArchitecture } from './product-architecture-store.js';
import { canonicalJson } from '../../../../shared/product-storage-projection.js';
import { approvedPlanVersion } from '../../../application/product-approval-projection.js';
import { advanceAutomationApproval } from '../../../application/product-approval-transition.js';
import { getAgentSnapshot } from './agent.js';
import { dedupeProductItineraryPois } from '../../../../shared/itinerary-poi-deduplication.js';

/**
 * 写入产品 product_json，可选更新 status。直接覆盖整个 product 字段。
 */
export function updateProduct(
  db: Database.Database,
  id: string,
  product: Record<string, unknown>,
  status?: ProductSummary["status"],
  expectedVersion?: number,
  source?: string,
) {
  const write = db.transaction(() => {
    const durableInput = dedupeProductItineraryPois(product);
    const basicInfo = durableInput.basicInfo && typeof durableInput.basicInfo === "object" && !Array.isArray(durableInput.basicInfo)
      ? durableInput.basicInfo as Record<string, unknown>
      : undefined;
    const nextName = typeof basicInfo?.supplierProductName === "string"
      ? basicInfo.supplierProductName.trim()
      : "";
    const current = db.prepare("SELECT product_json,product_json_version FROM products WHERE id=?").get(id) as {
      product_json: string; product_json_version?: number;
    } | undefined;
    if (!current) throw new Error("产品不存在");
    const expected = expectedVersion ?? (Number(current.product_json_version ?? 0) || 0);
    if (expected !== (current.product_json_version ?? 0)) throw new Error('产品内容已变更，请刷新后重试。');
    const oldPlan = JSON.parse(current.product_json) as Record<string, unknown>;
    const old = readProductArchitecture(db, id, oldPlan).product;
    const { plan } = writeProductArchitecture(db, id, durableInput);
    const durableProduct = readProductArchitecture(db, id, plan).product;
    const contentChanged = canonicalJson(oldPlan) !== canonicalJson(plan);
    // Evidence fields are stored outside product_json and composed back by
    // getProduct. Advance authority against that composed durable snapshot;
    // hashing the split plan alone creates a version no reader can reproduce.
    const approvalChanged = approvedPlanVersion({ product: old }) !== approvedPlanVersion({ product: durableProduct });
    const versionChanged = contentChanged || approvalChanged;
    const result = db.prepare("UPDATE products SET product_json=?, name=CASE WHEN ?<>'' THEN ? ELSE name END, status=COALESCE(?,status), updated_at=?, product_json_version=product_json_version+?,plan_version=plan_version+?,view_revision=view_revision+1 WHERE id=? AND product_json_version=?")
      .run(JSON.stringify(plan), nextName, nextName, status || null, now(), Number(versionChanged), Number(versionChanged), id, expected);
    if (result.changes === 0) throw new Error("产品内容已变更，请刷新后重试。");
    if (source === 'automation' && approvalChanged) {
      const snapshot = getAgentSnapshot(db, id);
      if (snapshot && advanceAutomationApproval(snapshot, old, durableProduct)) {
        db.prepare('UPDATE agent_snapshots SET snapshot_json=? WHERE local_product_id=?').run(JSON.stringify(snapshot), id);
      }
    }
    if (nextName) {
      db.prepare("UPDATE workflow_tasks SET product_name=? WHERE local_product_id=? AND product_name<>?")
        .run(nextName, id, nextName);
    }
  });
  write();
}

