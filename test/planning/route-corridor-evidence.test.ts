import assert from 'node:assert/strict';
import test from 'node:test';
import { resolvePlanningPoiAutoSelection } from '../../src/main/planning/poi-auto-selection.js';
import { routeLocationBlockers, corridorProvesLocation } from '../../src/shared/route-location-evidence.js';
import { corridorDistanceKm, geoPoint, ROUTE_CORRIDOR_RADIUS_KM } from '../../src/shared/route-corridor.js';

// 第2天原路线只有左侧行政锚点「日喀则」；「白居寺」同名候选分布在日喀则江孜（真实坐标）与林芝。
const route = '：日喀则-扎什伦布寺-白居寺';
function product(extra: Record<string, unknown> = {}) {
  return {
    basicInfo: { meetingCity: '拉萨', destinationCity: '拉萨', province: '西藏', days: 2,
      userIdea: `DAY1：拉萨-布达拉宫\nDAY2${route}` },
    itinerary: [
      { day: 1, title: '布达拉宫', spots: [{ name: '布达拉宫', poiName: '布达拉宫', poiId: 1, province: '西藏', city: '拉萨' }] },
      { day: 2, title: '日喀则 · 扎什伦布寺 · 白居寺', spots: [
        { name: '扎什伦布寺', poiName: '扎什伦布寺', poiId: 76348, province: '西藏', city: '日喀则', latitude: 29.267, longitude: 88.88 },
        { name: '白居寺', ...extra },
      ] },
    ],
    diagnostics: { routeLocations: [{ day: 2, name: '日喀则', districtId: 100, province: '西藏', city: '日喀则',
      position: 1, sourceRoute: route, routeKey: JSON.stringify([route, 2]) }] },
  } as Record<string, any>;
}
const linzhi = { selectable: true, index: 0, textFields: [], poiId: 900001, poiName: '白居寺', province: '西藏', city: '林芝', district: '巴宜', latitude: 29.65, longitude: 94.36 };
const gyantse = { selectable: true, index: 1, textFields: [], poiId: 76349, poiName: '白居寺', province: '西藏', city: '日喀则', district: '江孜', latitude: 28.927, longitude: 89.604 };
const context = { destinationCity: '日喀则', province: '西藏', itineraryDay: 2, spotName: '白居寺' } as any;
const select = (candidates: any[]) => resolvePlanningPoiAutoSelection({ localProductId: 'x', keyword: '白居寺', product: product(), context,
  detail: { httpStatus: 200, businessStatus: 'Success', poiListCount: candidates.length, best: candidates[0], candidates } as any,
  checkAvailability: async () => ({ status: 'available' }) });

test('单侧锚点：搜索结果只剩同省同名异城候选时，不凭「同省 + 原文点名 + 结果唯一」自动绑定', async () => {
  const result = await select([linzhi]);
  assert.equal(result.status, 'uncertain');
  assert.equal(result.reason, 'location_mismatch');
});

test('单侧锚点：正确候选在锚点城市内直接通过，并随匹配带回平台坐标', async () => {
  const result = await select([gyantse]);
  assert.equal(result.status, 'available');
  assert.deepEqual([result.match?.poiId, result.match?.latitude, result.match?.longitude], [76349, 28.927, 89.604]);
});

test('回读复核：已保存的同名异城绑定被阻塞；缺坐标即缺证据', () => {
  const wrong = product({ poiName: '白居寺', poiId: 900001, province: '西藏', city: '林芝', latitude: 29.65, longitude: 94.36 });
  assert.deepEqual(routeLocationBlockers(wrong).map(issue => issue.label), ['第2天景点地域：白居寺']);
  const missing = product({ poiName: '白居寺', poiId: 900001, province: '西藏', city: '林芝' });
  assert.deepEqual(routeLocationBlockers(missing).map(issue => issue.label), ['第2天景点地域：白居寺']);
  assert.deepEqual(routeLocationBlockers(product({ poiName: '白居寺', poiId: 76349, province: '西藏', city: '日喀则', latitude: 28.927, longitude: 89.604 })), []);
});

test('跨地州正确景点：坐标落在锚点城市已绑定景点的路线走廊内即放行，远离走廊则否', () => {
  // 羊卓雍错（山南）与日喀则锚点景点卡若拉冰川相距约 55 km，位于走廊内。
  const p = product();
  p.itinerary[1].spots[0] = { name: '卡若拉冰川', poiName: '卡若拉冰川', poiId: 91485, province: '西藏', city: '日喀则', latitude: 28.89, longitude: 90.17 };
  assert.equal(corridorProvesLocation(p, 2, { poiId: 82105, latitude: 28.926, longitude: 90.740 }), true);
  assert.equal(corridorProvesLocation(p, 2, { poiId: 900001, latitude: 29.65, longitude: 94.36 }), false);
  assert.equal(corridorProvesLocation(p, 2, { poiId: 82105 }), false);
});

test('走廊几何：折线距离、半径与坐标有效性', () => {
  const a = { lat: 29, lng: 88 }, b = { lat: 29, lng: 90 };
  assert.ok(corridorDistanceKm({ lat: 29.5, lng: 89 }, [a, b])! < 60);
  assert.ok(corridorDistanceKm({ lat: 33, lng: 89 }, [a, b])! > ROUTE_CORRIDOR_RADIUS_KM);
  assert.equal(corridorDistanceKm(a, []), undefined);
  assert.equal(geoPoint({ latitude: 0, longitude: 0 }), undefined);
  assert.equal(geoPoint({ latitude: 91, longitude: 10 }), undefined);
  assert.deepEqual(geoPoint({ latitude: 29.1, longitude: 88.2 }), { lat: 29.1, lng: 88.2 });
});
