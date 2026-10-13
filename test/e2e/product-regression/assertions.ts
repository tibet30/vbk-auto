import assert from 'node:assert/strict';
import { productNeedsVehicleResource } from '../../../src/shared/product-form.js';
import type { Json } from '../../../scripts/product-regression/corpus.js';

export function assertRepresentativeFeatures(key: string, p: Json) {
  const ops = p.operations;
  const traffic = ops.trafficLine;
  const days = p.itinerary as Json[];
  if (key === 'xian') {
    assert.equal(p.basicInfo.days, 6);
    assert.equal(p.presentation.cover.source, 'manualUpload');
    assert.deepEqual(days.slice(0, 5).map(day => day.hotelCity), ['眉', '太白', '留坝', '洋', '汉中']);
    assert.equal(days[5]?.hotelCity, undefined);
    assert.deepEqual(traffic.variants, ['flightRoundTrip', 'trainRoundTrip']);
    if (traffic.availability) {
      assert.equal(traffic.availability.endpointPlan.arrivalCity, '西安');
      assert.equal(traffic.availability.endpointPlan.departureCity, '汉中');
    }
  } else if (key === 'chaoshan') {
    assert.ok(p.manualReview.itinerarySpotRemovals.length);
    assert.equal(p.presentation.cover.source, 'ctripLibrary');
    assert.ok(new Set(days.filter(d => d.hotelCity).map(d => d.hotelCity)).size >= 2, JSON.stringify(days.map(d => ({ day: d.day, city: d.hotelCity }))));
  } else if (key === 'luzhou') {
    assert.equal(p.sales.productForm, 'groupTour');
    assert.equal(ops.transport, 'shared');
    assert.equal(traffic.enabled, false);
    assert.deepEqual(traffic.variants, []);
    assert.equal(productNeedsVehicleResource(p), false);
  } else if (key === 'chengdu') {
    assert.equal(p.sales.productForm, 'freeTravel');
    assert.equal(ops.transport, 'none');
    assert.equal(productNeedsVehicleResource(p), false);
  } else if (key === 'rikaze') {
    assert.deepEqual(ops.hotelRules, { autoMatch: true, grades: [3, 4, 5] });
    assert.deepEqual(traffic.variants, ['trainRoundTrip']);
    assert.ok(days.some(d => d.spots.filter((s: Json) => s.relation === 'or').length >= 2));
  } else throw new Error(`未定义代表特征：${key}`);
}
