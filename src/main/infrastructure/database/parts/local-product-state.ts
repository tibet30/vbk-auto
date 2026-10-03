import type Database from "better-sqlite3";
import type { ProductDetail } from "../../../../shared/contracts.js";
import type { ProductTelemetryReport } from "../../../../shared/product-usage-report.js";
import { getProduct, importProductSnapshot } from "./products.js";

export interface LocalProductState {
  ownerUserId: number;
  revision: number;
  planning?: ProductDetail["planning"];
  aiUsage?: ProductDetail["aiUsage"];
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
