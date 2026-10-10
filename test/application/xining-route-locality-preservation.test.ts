import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { VbkDatabase } from '../../src/main/infrastructure/database/database.js';
import { ProductMutationService } from '../../src/main/application/product-mutation-service.js';
import { buildProductSnapshot } from '../../src/main/infrastructure/database/parts/product-draft.js';
import { hotelStayRequirement } from '../../src/shared/hotel-stay-requirement.js';
import { hotelCandidateMeetsStay } from '../../src/shared/hotel-stay-requirement.js';
import { reconcileHotelStays } from '../../src/shared/reconcile-hotel-stays.js';

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
    assert.deepEqual(saved.product.itinerary![0]!.spots![0], p.product.itinerary![0]!.spots![0]);
    const changed = structuredClone(incoming); changed.itinerary[0].spots[0].poiId = 123;
    assert.equal(mutation.replace(p.id, changed).product.itinerary![0]!.spots![0]!.city, undefined, 'new binding does not inherit old locality');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('dated overnight endpoints persist before hotel search and reject cached Xining stays', () => {
  const p: any = { basicInfo: { days: 3, nights: 2, userIdea: '**10 月 7 号 D1：** 俄博梁 - 冷湖（冷湖石油小镇星空）\nD2：冷湖 - 黑独山 - 瓜州\nD3：瓜州 - 敦煌' },
    operations: { hotelTier: '当地5钻酒店/-38' }, itinerary: [
      { day: 1, hotel: '冷湖区域酒店（待核验）', spots: [{ name: '冷湖', poiId: 22881469, poiName: '冷湖', city: '海西', district: '茫崖' }] },
      { day: 2, hotel: '瓜州区域酒店（待核验）', spots: [{ name: '黑独山', poiId: 128522796, poiName: '黑独山', city: '海西', district: '茫崖' }] },
      { day: 3, hotel: '无', spots: [] },
    ] };
  const requirements = p.itinerary.slice(0, 2).map((day: any) => hotelStayRequirement(p, day));
  assert.equal(requirements[0].anchorName, '冷湖'); assert.equal(requirements[0].cityName, '茫崖');
  assert.equal(requirements[1].anchorName, '瓜州'); assert.equal(requirements[1].cityName, undefined, 'do not borrow the last scenic POI city');
  assert.equal(hotelCandidateMeetsStay({ anchorName: '西宁站', cityName: '西宁' }, requirements[1]), false, 'unknown city cannot admit a foreign cached anchor');
  const saved: any = reconcileHotelStays(p);
  saved.itinerary[0].hotel = '西宁酒店';
  saved.itinerary[0].hotelCandidates = [{ hotelName: '西宁酒店', cityName: '西宁', anchorName: '西宁站', diamond: 5 }];
  const reconciled: any = reconcileHotelStays(saved);
  assert.deepEqual(reconciled.itinerary[0].hotelCandidates, []);
  assert.match(reconciled.itinerary[0].hotel, /冷湖/);
  assert.equal(hotelStayRequirement(p, { ...p.itinerary[1], hotel: '西宁区域酒店（待核验）' }), undefined, 'generated placeholder cannot invent a different endpoint');
});

test('a stale resource mirror cannot reintroduce far hotels after itinerary candidates were narrowed', () => {
  const near = { hotelId: 134344591, hotelName: '云朵酒店(冷湖镇店)', anchorName: '俄博梁', cityName: '茫崖', distanceKm: 55.41, diamond: 4 };
  const far = { ...near, hotelId: 130242346, hotelName: '花土沟酒店', distanceKm: 166.22 };
  const p: any = { basicInfo: { days: 2, nights: 1 }, operations: { hotelResource: {
    resourceId: near.hotelId, resourceName: near.hotelName, dailyCandidates: [{ day: 1, candidates: [near, far] }],
  } }, itinerary: [{ day: 1, hotel: near.hotelName, hotelRequirement: {
    anchorName: '俄博梁', cityName: '茫崖', maxDistanceKm: 60,
  }, hotelCandidates: [near] }, { day: 2, hotel: '无' }] };
  const saved: any = reconcileHotelStays(p);
  assert.deepEqual(saved.itinerary[0].hotelCandidates, [near]);
  assert.deepEqual(saved.operations.hotelResource.dailyCandidates, [{ day: 1, candidates: [near] }]);
});
