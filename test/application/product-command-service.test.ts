import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VbkDatabase } from '../../src/main/infrastructure/database/database.js';
import { ProductMutationService } from '../../src/main/application/product-mutation-service.js';
import { canonicalJson } from '../../src/shared/product-storage-projection.js';

function fixture(run: (db: VbkDatabase, mutations: ProductMutationService, id: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbk-command-'));
  const db = new VbkDatabase(dir);
  try {
    const mutations = new ProductMutationService(db);
    const product = db.createProduct({ destination: '成都', days: 1, productForm: 'privateTour' });
    run(db, mutations, product.id);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

test('verified lodging POI corrects a stale hotel city after save without changing the product city anchor', () => fixture((db, mutations, id) => {
  const baseline = db.getProduct(id)!;
  mutations.commands.replaceFull({ localProductId: id, source: 'user', expectedVersion: baseline.productJsonVersion! }, {
    ...baseline.product,
    itinerary: [{ day: 1, hotel: '华阳住宿', spots: [{ name: '华阳古镇', poiName: '华阳古镇', poiId: 112647382,
      province: '陕西', city: '汉中', district: '洋县' }],
      hotelRequirement: { anchorName: '华阳古镇', cityName: '成都', maxDistanceKm: 10 } }],
  });
  const saved = db.getProduct(id)!;
  const day = (saved.product.itinerary as Record<string, unknown>[])[0]!;
  assert.equal(day.hotelRequirement, undefined);
  assert.equal(day.hotelCity, '洋');
  assert.equal((saved.product.basicInfo as Record<string, unknown>).meetingCity, '成都');
  assert.equal((saved.product.basicInfo as Record<string, unknown>).destinationCity, '成都');
}));

test('late cover result changes only its fields and preserves a concurrent itinerary edit', () => fixture((db, mutations, id) => {
  const baseline = db.getProduct(id)!;
  mutations.replace(id, { ...baseline.product, itinerary: [{ day: 1, title: '人工修改', spots: [], meals: '自理' }] });
  const next = mutations.commands.mergeChanges(id, baseline, { ...baseline.product, presentation: { cover: { type: 'none' } } }, 'resource');
  assert.equal((next.product.itinerary as Record<string, unknown>[])[0]!.title, '人工修改');
  assert.deepEqual(next.product.presentation, { cover: { type: 'none' } });
}));

test('late same-field replacement conflicts rather than overwriting an operator choice', () => fixture((db, mutations, id) => {
  const baseline = db.getProduct(id)!;
  mutations.replace(id, { ...baseline.product, presentation: { title: '人工修改' } });
  assert.throws(() => mutations.commands.mergeChanges(id, baseline,
    { ...baseline.product, presentation: { title: '旧查询结果' } }, 'resource'), /目标字段已变更/);
  assert.deepEqual(db.getProduct(id)!.product.presentation, { title: '人工修改' });
}));

test('resource results reject changed query conditions even if the target did not change', () => fixture((db, mutations, id) => {
  const baseline = db.getProduct(id)!;
  mutations.replace(id, { ...baseline.product, operations: { ...(baseline.product.operations as object), hotelTier: '4diamond' } });
  assert.throws(() => mutations.commands.resourceResult({ localProductId: id, source: 'resource',
    expectedVersion: db.getProduct(id)!.productJsonVersion! }, ['resourceResult'], 'late', {
      queryPath: ['operations'], queryFingerprint: canonicalJson(baseline.product.operations),
      targetPath: ['resourceResult'], targetFingerprint: canonicalJson(undefined),
    }), /核验条件/);
}));

test('failed research reconciliation rolls back the product and publishes nothing', () => fixture((db, _mutations, id) => {
  const baseline = db.getProduct(id)!;
  let notified = 0;
  const original = db.markResearchTasksSatisfiedByProduct.bind(db);
  db.markResearchTasksSatisfiedByProduct = () => { throw new Error('research failure'); };
  const mutations = new ProductMutationService(db, () => { notified++; });
  assert.throws(() => mutations.commands.manualField({ localProductId: id, source: 'user',
    expectedVersion: baseline.productJsonVersion! }, { field: 'basicInfoSubtitle', subtitle: '人工副标题' } as never), /research failure/);
  assert.deepEqual(db.getProduct(id)!.product, baseline.product);
  assert.equal(notified, 0);
  db.markResearchTasksSatisfiedByProduct = original;
}));

test('full replacement is versioned and unavailable to resource or AI sources', () => fixture((db, mutations, id) => {
  const baseline = db.getProduct(id)!;
  assert.throws(() => mutations.commands.replaceFull({ localProductId: id, source: 'ai', expectedVersion: 0 }, baseline.product), /整包替换/);
  mutations.replace(id, { ...baseline.product, custom: 'new' });
  assert.throws(() => mutations.commands.replaceFull({ localProductId: id, source: 'user', expectedVersion: 0 }, baseline.product), /已变更/);
}));

test('scoped commands preserve unknown stored fields hidden by the legacy compatibility normalizer', () => fixture((db, mutations, id) => {
  const product = db.getProduct(id)!;
  db.updateProduct(id, { ...product.product, operations: { ...(product.product.operations as object),
    vehicleResource: { extension: { preserved: true } } } });
  const baseline = db.getProduct(id)!;
  assert.equal((baseline.product.operations as Record<string, unknown>).vehicleResource &&
    ((baseline.product.operations as Record<string, unknown>).vehicleResource as Record<string, unknown>).extension, undefined);
  const saved = mutations.commands.manualField({ localProductId: id, source: 'user', expectedVersion: baseline.planVersion! },
    { field: 'basicInfoSubtitle', subtitle: '更新副标题' });
  assert.deepEqual(((saved.plan!.operations as Record<string, unknown>).vehicleResource as Record<string, unknown>).extension,
    { preserved: true });
}));
