import type Database from 'better-sqlite3';
import type { ProductResourceEvidence } from '../../../../shared/contracts-product-architecture.js';
import { canonicalJson, composeProduct, splitProduct } from '../../../../shared/product-storage-projection.js';

const emptyEvidence = (): ProductResourceEvidence => ({ version: 1, source: 'verified', fields: [] });
export function readProductArchitecture(db: Database.Database, id: string, plan: Record<string, unknown>) {
  const row = db.prepare('SELECT * FROM product_resource_evidence WHERE local_product_id=?').get(id) as {
    payload_json: string; evidence_version: number;
  } | undefined;
  const diagnostic = db.prepare('SELECT payload_json FROM product_runtime_diagnostics WHERE local_product_id=?').get(id) as {
    payload_json: string;
  } | undefined;
  const evidence = row ? JSON.parse(row.payload_json) as ProductResourceEvidence : emptyEvidence();
  const diagnostics = diagnostic ? JSON.parse(diagnostic.payload_json) as Record<string, unknown> : {};
  return { product: composeProduct(plan, evidence, diagnostics), evidence, evidenceVersion: row?.evidence_version ?? 0 };
}

/** Called only inside the product transaction. Omitted diagnostics do not erase evidence. */
export function writeProductArchitecture(db: Database.Database, id: string, product: Record<string, unknown>) {
  const { plan, evidence, diagnostics } = splitProduct(product);
  const previous = db.prepare('SELECT payload_json,evidence_version FROM product_resource_evidence WHERE local_product_id=?')
    .get(id) as { payload_json: string; evidence_version: number } | undefined;
  const old = previous ? JSON.parse(previous.payload_json) as ProductResourceEvidence : emptyEvidence();
  evidence.source = old.source;
  evidence.observations = old.observations;
  const changed = canonicalJson(old.fields) !== canonicalJson(evidence.fields);
  db.prepare(`INSERT INTO product_resource_evidence VALUES(?,?,?) ON CONFLICT(local_product_id)
    DO UPDATE SET payload_json=excluded.payload_json,evidence_version=excluded.evidence_version`)
    .run(id, JSON.stringify(evidence), (previous?.evidence_version ?? 0) + Number(changed));
  if (Object.hasOwn(product, 'diagnostics')) {
    db.prepare(`INSERT INTO product_runtime_diagnostics VALUES(?,?) ON CONFLICT(local_product_id)
      DO UPDATE SET payload_json=excluded.payload_json`).run(id, JSON.stringify(diagnostics));
  }
  return { plan, evidenceChanged: changed };
}

export function recordResourceObservation(db: Database.Database, id: string,
  observation: NonNullable<ProductResourceEvidence['observations']>[number]): void {
  db.transaction(() => {
    const row = db.prepare('SELECT payload_json FROM product_resource_evidence WHERE local_product_id=?').get(id) as { payload_json: string } | undefined;
    if (!row) return;
    const evidence = JSON.parse(row.payload_json) as ProductResourceEvidence;
    evidence.observations = [...(evidence.observations ?? []), observation];
    db.prepare('UPDATE product_resource_evidence SET payload_json=?,evidence_version=evidence_version+1 WHERE local_product_id=?')
      .run(JSON.stringify(evidence), id);
  })();
}
