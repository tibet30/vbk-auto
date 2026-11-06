import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveRouteLocations } from '../../src/main/planning/route-location-resolution.js';
import { routeLocationsForSpot, routeLocationBlockers } from '../../src/shared/route-location-evidence.js';

/**
 * 成都 48bff2f7 第4天原文「九寨沟-成都」。运营要求「第四天要有九寨沟的景区」，
 * 目录官方名是「九寨沟风景区」：原路线站点「九寨沟」加景区类别尾缀仍是同一站，
 * 必须由该站的行政锚点（阿坝州九寨沟县）证明地域，不能报「缺少原路线核验证据」。
 */
type Json = Record<string, any>;
const districts: Record<string, Json> = {
  九寨沟: { districtId: 25, districtName: '九寨沟县', districtType: 'County', parents: [
    { districtName: '阿坝藏族羌族自治州', districtType: 'City' }, { districtName: '四川', districtType: 'Province' }] },
  成都: { districtId: 104, districtName: '成都', districtType: 'City', parents: [{ districtName: '四川', districtType: 'Province' }] },
};

async function productWith(spot: Json): Promise<Json> {
  const product: Json = {
    basicInfo: { province: '四川', meetingCity: '成都', destinationCity: '成都', days: 4, userIdea: 'Day4：九寨沟-成都' },
    itinerary: [{ day: 4, title: '专车服务｜九寨沟-成都', spots: [spot] }],
    diagnostics: {},
  };
  product.diagnostics.routeLocations = await resolveRouteLocations(product, async (name: string) => districts[name]);
  return product;
}

const jiuzhai = (city: string): Json => ({ name: '九寨沟风景区', kind: 'attraction', poiName: '九寨沟风景区', poiId: 89895,
  province: '四川', city, district: '九寨沟县' });

test('「九寨沟风景区」落在原路线站点「九寨沟」：取该站行政锚点作地域证据', async () => {
  const product = await productWith(jiuzhai('阿坝藏族羌族自治州'));
  assert.deepEqual(routeLocationsForSpot(product, product.itinerary[0], '九寨沟风景区'),
    [{ province: '四川', city: '阿坝', bounded: true }]);
  assert.deepEqual(routeLocationBlockers(product), []);
});

test('同名景区绑定到锚点以外的城市，地域待处理项仍保留', async () => {
  const product = await productWith(jiuzhai('绵阳'));
  assert.equal(routeLocationBlockers(product).length, 1);
});
