import assert from 'node:assert/strict';
import test from 'node:test';
import { normaliseItineraryArrivalTitle } from '../../src/shared/itinerary-arrival-title.js';
import { normaliseProductDraft } from '../../src/main/data/product-normalize.js';
import { ProductMutationService } from '../../src/main/application/product-mutation-service.js';
import type { ProductDetail } from '../../src/shared/contracts.js';

test('首日使用接团城市短名，保留原标题与后续跨城路线，重复处理不叠加', () => {
  const product = { basicInfo: { meetingCity: '成都市', destinationCity: '汉中' }, itinerary: [
    { day: 1, title: '接站 · 自由活动', spots: [] },
    { day: 2, title: '汉中返程', spots: [] },
  ] };
  const result = normaliseItineraryArrivalTitle(product);
  assert.equal((result.itinerary as typeof product.itinerary)[0]!.title, '【出发地-成都】接站 · 自由活动');
  assert.deepEqual((result.itinerary as typeof product.itinerary)[1], product.itinerary[1]);
  assert.deepEqual(normaliseItineraryArrivalTitle(result), result);
  assert.equal(product.itinerary[0]!.title, '接站 · 自由活动');
});

test('目的地兜底并更新旧前缀；无城市或标题时不虚构内容', () => {
  const result = normaliseItineraryArrivalTitle({ basicInfo: { destinationCity: '日喀则市' },
    itinerary: [{ day: 1, title: '【出发地-成都】接站' }] });
  assert.equal((result.itinerary as Array<{ title: string }>)[0]!.title, '【出发地-日喀则】接站');
  for (const product of [
    { itinerary: [{ day: 1, title: '接站' }] },
    { basicInfo: { meetingCity: '成都' }, itinerary: [{ day: 1, title: '' }] },
  ]) assert.deepEqual(normaliseItineraryArrivalTitle(product), product);
});

test('生成草稿与统一保存回读使用锁定城市，显式城市纠正更新首日', () => {
  const draft = normaliseProductDraft({ basicInfo: { meetingCity: '西安' },
    itinerary: [{ day: 1, title: '抵达接站', description: '自由活动', hotel: '无', meals: '自理' }] });
  assert.equal((draft.itinerary as Array<{ title: string }>)[0]!.title, '【出发地-西安】抵达接站');
  let saved = { id: 'arrival', product: draft, messages: [], researchTasks: [], status: 'planning' } as unknown as ProductDetail;
  const service = new ProductMutationService({ getProduct: () => saved,
    updateProduct: (_id, product) => { saved = { ...saved, product }; } });
  const incoming = { ...draft, basicInfo: { meetingCity: '成都', destinationCity: '成都' } };
  const locked = service.replace('arrival', incoming);
  assert.equal((locked.product.itinerary as Array<{ title: string }>)[0]!.title, '【出发地-西安】抵达接站');
  const corrected = service.replace('arrival', incoming, { allowMeetingCityCorrection: true });
  assert.equal((corrected.product.itinerary as Array<{ title: string }>)[0]!.title, '【出发地-成都】抵达接站');
});
