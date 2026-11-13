import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { VbkDatabase } from '../../src/main/infrastructure/database/database.js';
import { ProductMutationService } from '../../src/main/application/product-mutation-service.js';
import { buildProductSnapshot } from '../../src/main/infrastructure/database/parts/product-draft.js';
import { withoutSpotIds } from '../helpers/without-spot-ids.js';

test('the same complete POI binding retains its omitted native locality through a full array patch', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vbk-poi-locality-')); const db = new VbkDatabase(dir);
  try {
    const p = buildProductSnapshot({ destination: '西宁', days: 1, productForm: 'privateTour', userIdea: 'D1：大柴旦翡翠湖 - 俄博梁' });
    p.product.itinerary = [{ day: 1, title: '俄博梁', description: '原路线', hotel: '无', meals: '自理', spots: [
      { name: '俄博梁', poiName: '俄博梁', poiId: 56810058, province: '青海', city: '海西', district: '茫崖', kind: 'attraction' },
    ] }] as any;
    db.importProductSnapshot(p);
    const mutation = new ProductMutationService(db);
    const incoming = structuredClone(p.product) as any;
    delete incoming.itinerary[0].spots[0].province; delete incoming.itinerary[0].spots[0].city; delete incoming.itinerary[0].spots[0].district;
    const saved = mutation.replace(p.id, incoming);
    assert.deepEqual(withoutSpotIds(saved.product.itinerary![0]!.spots![0]), withoutSpotIds(p.product.itinerary![0]!.spots![0]));
    const changed = structuredClone(incoming); changed.itinerary[0].spots[0].poiId = 123;
    assert.equal(mutation.replace(p.id, changed).product.itinerary![0]!.spots![0]!.city, undefined, 'new binding does not inherit old locality');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

