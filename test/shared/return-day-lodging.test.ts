import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseReturnDayLodging, hasItineraryHotelStay } from '../../src/shared/itinerary-hotel.js';
import { normaliseProductDraft } from '../../src/main/data/product-normalize.js';
import { reconcileHotelStays } from '../../src/shared/reconcile-hotel-stays.js';

const basic = { days: 6, nights: 5 };
const day = { day: 6, title: '汉中送飞机/送高铁', description: '按返程时间送站', hotel: '敬请自理', meals: '敬请自理', spots: [] };
test('6天5晚送站日的自理占位不会再要求第六晚酒店，餐食保持自理', () => {
  for (const normalise of [normaliseProductDraft, reconcileHotelStays]) {
    const p = normalise({ basicInfo: basic, itinerary: [day] });
    const last = (p.itinerary as any[])[0];
    assert.equal(last.hotel, '无当日住宿安排');
    assert.equal(last.meals, '敬请自理');
    assert.equal(hasItineraryHotelStay(last.hotel), false);
    assert.equal((p.itinerary as any[]).length, 1);
  }
});
test('中间住宿日、额外一晚、明确末日酒店及候选都不能被送站文案清除', () => {
  for (const [row, info] of [
    [{ ...day, day: 5 }, basic], [day, { days: 6, nights: 6 }],
    [{ ...day, hotel: '汉中酒店' }, basic], [{ ...day, hotelRequirement: { anchorName: '汉中' } }, basic],
    [{ ...day, hotelCandidates: [{ hotelId: 1 }] }, basic], [{ ...day, title: '汉中游览', description: '自由活动' }, basic],
  ] as const) assert.equal(normaliseReturnDayLodging(row, info), row);
});
