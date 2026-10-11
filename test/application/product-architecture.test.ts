import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { VbkDatabase } from '../../src/main/infrastructure/database/database.js';
import { applyMigrations } from '../../src/main/infrastructure/database/parts/migrations.js';
import { legacyMigrations, runDatabaseMigrations } from '../../src/main/infrastructure/database/parts/migration-registry.js';
import { canonicalJson, composeProduct, splitProduct } from '../../src/shared/product-storage-projection.js';
import { approvedPlanVersion } from '../../src/main/application/product-approval-projection.js';

test('split and compose preserve approved candidates, route evidence and unknown extensions', () => {
  const product = { basicInfo: { meetingCity: '成都' }, custom: { untouched: true },
    itinerary: [{ day: 1, hotelCandidates: [{ hotelId: 1, hotelName: '酒店', diamond: 4 }] }],
    operations: { hotelResource: { resourceName: '酒店', resourceId: 9 }, trafficLine: { availability: { flight: true } } },
    diagnostics: { routeAdministrativeNodes: [{ name: '成都', districtId: 1 }], message: 'running' } };
  const split = splitProduct(product);
  assert.equal(split.plan.diagnostics, undefined);
  assert.equal((split.plan.itinerary as Record<string, unknown>[])[0]!.hotelCandidates, undefined);
  assert.equal(canonicalJson(composeProduct(split.plan, split.evidence, split.diagnostics)), canonicalJson(product));
  const hash = approvedPlanVersion({ product });
  assert.equal(hash, approvedPlanVersion({ product: { ...product, diagnostics: { message: 'changed' } } }));
  assert.notEqual(hash, approvedPlanVersion({ product: { ...product, itinerary: [{ day: 1, hotelCandidates: [{ hotelId: 2 }] }] } }));
});

test('diagnostics only writes do not advance plan version; every persisted fact advances view revision', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbk-architecture-'));
  const db = new VbkDatabase(dir);
  try {
    const product = db.createProduct({ destination: '成都', days: 2, productForm: 'privateTour' });
    db.updateProduct(product.id, { ...product.product, diagnostics: { message: 'running' } });
    const next = db.getProduct(product.id)!;
    assert.equal(next.planVersion, product.planVersion);
    assert.equal(next.productJsonVersion, product.productJsonVersion);
    assert.ok(next.viewRevision! > product.viewRevision!);
    db.addMessage(product.id, 'assistant', '准备继续');
    assert.ok(db.getProduct(product.id)!.viewRevision! > next.viewRevision!);
    const raw = new Database(path.join(dir, 'vbk-desktop.sqlite'));
    assert.throws(() => raw.prepare("UPDATE products SET status='blocked' WHERE id=?").run(product.id), /vbk_architecture_writer/);
    raw.close();
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('one-shot migration preserves WAL records, creates a backup, and does not rerun', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbk-migration-'));
  const db = new Database(path.join(dir, 'vbk-desktop.sqlite'));
  try {
    db.pragma('journal_mode=WAL');
    applyMigrations(db, legacyMigrations);
    const product = { custom: 'preserved', itinerary: [], diagnostics: { routeAdministrativeNodes: [{ districtId: 1 }] } };
    db.prepare('INSERT INTO products(id,name,status,product_json,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .run('legacy', '旧产品', 'planning', JSON.stringify(product), 'old', 'old');
    runDatabaseMigrations(db);
    assert.equal(fs.readdirSync(dir).filter(name => name.includes('before-architecture')).length, 1);
    assert.equal((db.prepare('SELECT product_json FROM products').get() as { product_json: string }).product_json,
      JSON.stringify({ custom: 'preserved', itinerary: [] }));
    runDatabaseMigrations(db);
    assert.equal(fs.readdirSync(dir).filter(name => name.includes('before-architecture')).length, 1);
    const backup = new Database(path.join(dir, fs.readdirSync(dir).find(name => name.includes('before-architecture'))!));
    assert.equal((backup.prepare('SELECT product_json FROM products').get() as { product_json: string }).product_json, JSON.stringify(product));
    backup.close();
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('bad historical JSON rolls back schema, records and migration marker together', () => {
  const db = new Database(':memory:');
  try {
    applyMigrations(db, legacyMigrations);
    db.prepare('INSERT INTO products(id,name,status,product_json,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .run('broken', '旧产品', 'planning', '{bad', 'old', 'old');
    assert.throws(() => runDatabaseMigrations(db), /broken/);
    assert.equal(db.prepare("SELECT 1 FROM migrations WHERE id='0017_product_architecture'").get(), undefined);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='product_resource_evidence'").get(), undefined);
    assert.equal((db.prepare('SELECT product_json FROM products').get() as { product_json: string }).product_json, '{bad');
  } finally { db.close(); }
});
