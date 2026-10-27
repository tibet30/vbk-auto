import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveRouteLocations } from '../../src/main/planning/route-location-resolution.js';
import { buildPoiContextForItineraryDay } from '../../src/main/planning/poi-context.js';
import { isPlanningPoiCandidateInContext } from '../../src/main/planning/poi-auto-selection.js';
import { routeLocationsForSpot, routeLocationBlockers } from '../../src/shared/route-location-evidence.js';

/**
 * 吉林 cb10213f 第5天原文：「牡丹江-…-雪乡轻旅拍体验-…-雪地蹦迪-雪乡」。
 * 「雪乡」既是终点站，也出现在「雪乡轻旅拍体验」「雪乡夜景」等长站名内部；
 * 只有整段等于「雪乡」的终点才能证明这天的落脚行政城市。
 */
const DAY_FIVE = '第五天牡丹江-横道河子百年小镇&机车库&油画村-雪乡轻旅拍体验-雪韵大街&棒槌山雪乡夜景&雪地蹦迪-雪乡';
const DAY_SEVEN = '第七天哈尔滨-索菲亚教堂-中央大街-防洪纪念塔-哈尔滨';

type Json = Record<string, any>;
const districts: Record<string, { districtId: number; districtName: string; districtType: string; parents: any[] }> = {
  牡丹江: { districtId: 264, districtName: '牡丹江', districtType: 'City', parents: [
    { districtName: '黑龙江', districtType: 'Province' }] },
  海林: { districtId: 1219, districtName: '海林', districtType: 'City', parents: [
    { districtName: '牡丹江', districtType: 'City' }, { districtName: '黑龙江', districtType: 'Province' }] },
  哈尔滨: { districtId: 151, districtName: '哈尔滨', districtType: 'City', parents: [
    { districtName: '黑龙江', districtType: 'Province' }] },
  吉林市: { districtId: 267, districtName: '吉林市', districtType: 'City', parents: [
    { districtName: '吉林', districtType: 'Province' }] },
  舒兰: { districtId: 268, districtName: '舒兰', districtType: 'City', parents: [
    { districtName: '吉林市', districtType: 'City' }, { districtName: '吉林', districtType: 'Province' }] },
};

function productWith(day: Json, spots: Json[]): Json {
  return {
    basicInfo: { province: '吉林', meetingCity: '吉林', destinationCity: '吉林', userIdea: `${DAY_FIVE} ${DAY_SEVEN}` },
    itinerary: [{ day: 5, title: '牡丹江 · 雪乡', spots },
      { day: 7, title: '哈尔滨', spots: [{ name: '中央大街', kind: 'attraction' }] }],
    diagnostics: {} as Json,
  };
}

async function resolve(product: Json) {
  product.diagnostics.routeLocations = await resolveRouteLocations(product, async (name: string) => districts[name]);
  return product;
}

const bound = (name: string, poiName: string, poiId: number, province: string, city: string, district: string): Json =>
  ({ name, kind: 'attraction', poiName, poiId, province, city, district });

test('站名只作为完整路段命中：雪乡取终点锚点牡丹江，不被长站名内部的子串干扰', async () => {
  const product = await resolve(productWith({}, [bound('雪乡', '吉林雪乡', 81953068, '吉林', '吉林市', '舒兰')]));
  assert.deepEqual(routeLocationsForSpot(product, product.itinerary[0], '雪乡'),
    [{ province: '黑龙江', city: '牡丹江', bounded: false }]);
});

test('当天路线进入外省时，槽位地域跟随终点锚点而非接团省份', async () => {
  const product = await resolve(productWith({}, [bound('雪乡', '吉林雪乡', 81953068, '吉林', '吉林市', '舒兰')]));
  const context = buildPoiContextForItineraryDay(product, '吉林', product.itinerary[0], '雪乡');
  assert.equal(context.province, '黑龙江');
  assert.equal(context.destinationCity, '牡丹江');
});

test('同名外省候选不能再被绑定为雪乡，原路线城市候选仍可绑定', async () => {
  const product = await resolve(productWith({}, [bound('雪乡', '吉林雪乡', 81953068, '吉林', '吉林市', '舒兰')]));
  const context = buildPoiContextForItineraryDay(product, '吉林', product.itinerary[0], '雪乡');
  const wrong = { index: 0, poiName: '吉林雪乡', poiId: 81953068, province: '吉林', city: '吉林市', district: '舒兰', selectable: true };
  const right = { index: 1, poiName: '中国雪乡', poiId: 4666805, province: '黑龙江', city: '牡丹江', district: '海林', selectable: true };
  assert.equal(isPlanningPoiCandidateInContext(wrong, context, product, '雪乡', [wrong, right]), false);
  assert.equal(isPlanningPoiCandidateInContext(right, context, product, '雪乡', [wrong, right]), true);
});

test('已保存的外省雪乡绑定保留地域待处理项，绑定原路线城市后清除', async () => {
  const product = await resolve(productWith({}, [bound('雪乡', '吉林雪乡', 81953068, '吉林', '吉林市', '舒兰')]));
  assert.deepEqual(routeLocationBlockers(product).map(issue => issue.label), ['第5天景点地域：雪乡']);
  product.itinerary[0].spots = [bound('雪乡', '中国雪乡', 4666805, '黑龙江', '牡丹江', '海林')];
  assert.deepEqual(routeLocationBlockers(product), []);
});

test('删除或改分类其他行程项后，未改原路线的行政回执仍然有效', async () => {
  const product = await resolve(productWith({}, [
    bound('横道河子百年小镇', '横道河子镇', 56809774, '黑龙江', '牡丹江', '海林'),
    bound('机车库', '中东铁路机车库', 24654665, '黑龙江', '牡丹江', '海林'),
    { name: '雪韵大街', kind: 'attraction' },
  ]));
  assert.deepEqual(routeLocationBlockers(product), []);

  product.itinerary[0].spots.splice(2, 1);
  product.itinerary[0].spots[1].kind = 'other';

  assert.deepEqual(routeLocationBlockers(product), []);
  assert.deepEqual(routeLocationsForSpot(product, product.itinerary[0], '横道河子百年小镇'),
    [{ province: '黑龙江', city: '牡丹江', bounded: false }]);
});

test('往返重复站名不猜位置，保持无地域回执', async () => {
  const product = await resolve(productWith({}, [bound('中央大街', '中央大街', 77071, '黑龙江', '哈尔滨', '哈尔滨')]));
  assert.deepEqual(routeLocationsForSpot(product, product.itinerary[1], '哈尔滨'), []);
});

test('同省异城不能由原路线中其他城市或同省锚点背书', () => {
  const route = '拉萨-日喀则-珠峰-日喀则-拉萨';
  const product: Json = {
    basicInfo: { province: '西藏', userIdea: `第一天${route}` },
    itinerary: [{ day: 1, spots: [bound('珠峰', '珠峰', 1, '西藏', '拉萨', '')] }],
    diagnostics: { routeLocations: [
      { day: 1, name: '日喀则', position: route.indexOf('日喀则'), sourceRoute: route,
        routeKey: 'receipt', districtId: 1, province: '西藏', city: '日喀则' },
      { day: 1, name: '日喀则', position: route.lastIndexOf('日喀则'), sourceRoute: route,
        routeKey: 'receipt', districtId: 1, province: '西藏', city: '日喀则' },
    ] },
  };
  assert.equal(routeLocationBlockers(product).length, 1);
});
