import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProductSnapshot } from '../../src/main/infrastructure/database/parts/product-draft.js';
import { normaliseNumberedRouteAdministrativeNodes } from '../../src/main/planning/numbered-route-administrative.js';
import { routeLocationBlockers } from '../../src/shared/route-location-evidence.js';

/**
 * 成都 48bff2f7：原文「Day4：九寨沟-成都」，「九寨沟」在平台唯一命中九寨沟县。
 * 运营随后明确「第四天要有九寨沟的景区」，这个槽位必须保留为景点并可绑定 POI。
 */
type Json = Record<string, any>;
const districts: Record<string, Json> = {
  九寨沟: { districtId: 25, districtName: '九寨沟县', districtType: 'County', parents: [
    { districtName: '阿坝藏族羌族自治州', districtType: 'City' }, { districtName: '四川', districtType: 'Province' }] },
  成都: { districtId: 104, districtName: '成都', districtType: 'City', parents: [{ districtName: '四川', districtType: 'Province' }] },
};
const page = { nativeOnly: true, vbkSessionFetch: async (request: any) => ({ status: 200, payload: {
  ResponseStatus: { Ack: 'Success' }, districts: districts[request.body.keyword] ? [districts[request.body.keyword]] : [] } }) } as any;

function detail(messages: Array<{ role: string; content: string }>, spot: Json = { name: '九寨沟', kind: 'attraction' }) {
  const value = buildProductSnapshot({ destination: '成都', days: 4, productForm: 'privateTour',
    userIdea: 'Day1：成都-毕棚沟-住：黑水\nDay2：黑水-达古冰川-住：川主寺\nDay3：川主寺-黄龙景区-住：九寨沟沟口\nDay4：九寨沟-成都' });
  Object.assign(value.product.basicInfo!, { province: '四川' });
  value.product.itinerary = [1, 2, 3].map(day => ({ day, title: `D${day}`, spots: [] }))
    .concat([{ day: 4, title: '专车服务｜九寨沟-成都', spots: [spot] }] as any) as any;
  value.messages = messages as any;
  return value;
}

test('未明确要求景区时，平台唯一县级同名仍转成交通衔接', async () => {
  const result = await normaliseNumberedRouteAdministrativeNodes(detail([]), page);
  assert.deepEqual(result?.converted, [{ day: 4, name: '九寨沟', districtId: 25 }]);
  assert.deepEqual(result?.itinerary[3].spots, []);
});

test('运营明确「第四天要有九寨沟的景区」时保留景点槽位，不记行政节点', async () => {
  const result = await normaliseNumberedRouteAdministrativeNodes(detail([{ role: 'user', content: '第四天要有九寨沟的景区。' }]), page);
  assert.deepEqual(result?.converted, []);
  assert.deepEqual(result?.itinerary[3].spots.map((spot: Json) => spot.name), ['九寨沟']);
});

test('Agent 对话里的明确要求同样保留景点，且不改写第4天原路线锚点', async () => {
  const result = await normaliseNumberedRouteAdministrativeNodes(detail([]), page,
    [{ role: 'user', content: '第四天我不希望延后录入，我就需要第四天必须要有九寨沟的景点POI录进去。' }]);
  assert.deepEqual(result?.converted, []);
  assert.deepEqual(result?.locations.filter((node: Json) => node.day === 4).map((node: Json) => node.name), ['九寨沟', '成都']);
});

test('绑定九寨沟风景区后重算路线锚点，第4天不再报地域缺证据', async () => {
  const bound = { name: '九寨沟', kind: 'attraction', poiName: '九寨沟风景区', poiId: 89895,
    province: '四川', city: '阿坝藏族羌族自治州', district: '九寨沟县' };
  const value = detail([{ role: 'user', content: '第四天要有九寨沟的景区。' }], bound);
  const result = await normaliseNumberedRouteAdministrativeNodes(value, page);
  const product = { ...value.product, itinerary: result!.itinerary, diagnostics: { routeLocations: result!.locations } };
  assert.deepEqual(routeLocationBlockers(product), []);
});
