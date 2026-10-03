import type Database from "better-sqlite3";
import type { ProductDetail, ProductSummary } from "../../../../shared/contracts.js";
import type { ProductTelemetryReport } from "../../../../shared/product-usage-report.js";
import { getProduct, importProductSnapshot } from "./products.js";

export interface LocalProductState {
  ownerUserId: number;
  revision: number;
  planning?: ProductDetail["planning"];
  aiUsage?: ProductDetail["aiUsage"];
  vbkAccount?: string;
}

export interface OwnedLocalProductSummary extends Pick<ProductSummary, "id" | "name" | "status" | "productId" | "updatedAt"> {
  revision: number;
  vbkAccount?: string;
}

export function readLocalProductState(db: Database.Database, id: string): LocalProductState | undefined {
  const row = db.prepare("SELECT owner_user_id,revision,payload_json FROM local_product_state WHERE local_product_id=?")
    .get(id) as { owner_user_id: number; revision: number; payload_json: string } | undefined;
  return row ? { ...JSON.parse(row.payload_json), ownerUserId: row.owner_user_id, revision: row.revision } : undefined;
}

export function saveLocalProductState(db: Database.Database, snapshot: ProductDetail, ownerUserId: number, revision: number): ProductDetail {
  return db.transaction(() => {
    attachLocalProductState(db, snapshot, ownerUserId, revision);
    importProductSnapshot(db, snapshot);
    return getProduct(db, snapshot.id)!;
  })();
}

export function attachLocalProductState(db: Database.Database, snapshot: ProductDetail, ownerUserId: number, revision: number): void {
  const existing = readLocalProductState(db, snapshot.id);
  if (existing && existing.ownerUserId !== ownerUserId) throw new Error("产品归属不一致，不能覆盖。");
  const metadata = { planning: snapshot.planning, aiUsage: snapshot.aiUsage, vbkAccount: snapshot.vbkAccount };
  db.prepare(`INSERT INTO local_product_state VALUES(?,?,?,?) ON CONFLICT(local_product_id)
    DO UPDATE SET revision=excluded.revision,payload_json=excluded.payload_json`)
    .run(snapshot.id, ownerUserId, revision, JSON.stringify(metadata));
}

export function ownedLocalProductIds(db: Database.Database, ownerUserId: number): string[] {
  return (db.prepare(`SELECT s.local_product_id FROM local_product_state s JOIN products p ON p.id=s.local_product_id
    WHERE s.owner_user_id=? ORDER BY p.updated_at DESC`).all(ownerUserId) as { local_product_id: string }[])
    .map(row => row.local_product_id);
}

/** List-only projection: do not hydrate messages, research tasks, or automation. */
export function listOwnedLocalProductSummaries(db: Database.Database, ownerUserId: number): OwnedLocalProductSummary[] {
  const rows = db.prepare(`SELECT p.id,p.name,p.status,p.product_id,p.updated_at,s.revision,s.payload_json
    FROM local_product_state AS s JOIN products AS p ON p.id=s.local_product_id
    WHERE s.owner_user_id=? ORDER BY p.updated_at DESC`).all(ownerUserId) as Array<{
      id: string; name: string; status: ProductSummary["status"]; product_id: string | null;
      updated_at: string; revision: number; payload_json: string;
    }>;
  return rows.map((row) => {
    const metadata = JSON.parse(row.payload_json) as { vbkAccount?: unknown };
    return {
      id: row.id, name: row.name, status: row.status, productId: row.product_id || undefined,
      updatedAt: row.updated_at, revision: row.revision,
      ...(typeof metadata.vbkAccount === "string" && metadata.vbkAccount ? { vbkAccount: metadata.vbkAccount } : {}),
    };
  });
}

export function enqueueDiagnostic(db: Database.Database, ownerUserId: number, eventId: string, report: ProductTelemetryReport): void {
  db.prepare("INSERT OR IGNORE INTO product_diagnostic_outbox VALUES(?,?,?,0,?)")
    .run(ownerUserId, eventId, JSON.stringify(report), new Date().toISOString());
}

export function pendingDiagnostics(db: Database.Database, ownerUserId: number): Array<{ eventId: string; report: ProductTelemetryReport }> {
  return (db.prepare(`SELECT event_id,payload_json FROM product_diagnostic_outbox WHERE owner_user_id=? AND sent=0
    ORDER BY created_at LIMIT 50`).all(ownerUserId) as { event_id: string; payload_json: string }[])
    .map(row => ({ eventId: row.event_id, report: JSON.parse(row.payload_json) }));
}

export function markDiagnosticSent(db: Database.Database, ownerUserId: number, eventId: string): void {
  db.prepare("UPDATE product_diagnostic_outbox SET sent=1,payload_json='{}' WHERE owner_user_id=? AND event_id=?")
    .run(ownerUserId, eventId);
}
