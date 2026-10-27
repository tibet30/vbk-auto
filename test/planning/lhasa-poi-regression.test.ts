import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { buildPoiContextForItineraryDay } from '../../src/main/planning/poi-context.js';
import { isPlanningPoiCandidateInContext } from '../../src/main/planning/poi-auto-selection.js';
import { resolveRouteLocations } from '../../src/main/planning/route-location-resolution.js';
import { routeLocationsForSpot, routeLocationBlockers } from '../../src/shared/route-location-evidence.js';
import { poiIdentityBlockers } from '../../src/shared/poi-candidate-identity.js';
import { hasDefinitePoiLocationConflict } from '../../src/main/planning/poi-location-conflict.js';

const source = JSON.parse(readFileSync(new URL('../fixtures/lhasa-poi-regression/route.json', import.meta.url), 'utf8'));
const locations: Record<string, [number, string, string?]> = {
  拉萨: [41, '拉萨'], 日喀则: [100, '日喀则'], 萨嘎: [120381, '日喀则', '萨嘎'],
  仲巴: [120376, '日喀则', '仲巴'], 札达: [2454, '阿里', '札达'],
};
// 平台坐标（2026-10-27 只读抓取）：跨地州景点靠路线走廊证明地点，绑定时随 POI 一并写入。
const coordinates: Record<string, { latitude: number; longitude: number }> = JSON.parse(readFileSync(
  new URL('../fixtures/lhasa-poi-regression/coordinates.json', import.meta.url), 'utf8')).points;
const at = (poiId: number) => coordinates[poiId] ? { latitude: coordinates[poiId]!.latitude, longitude: coordinates[poiId]!.longitude } : {};
const candidate = (poiName: string, poiId: number, city: string, district?: string) => ({
  index: 0, poiName, poiId, city, province: '西藏', district, selectable: true, textFields: [], ...at(poiId),
});

async function resolveLocations(p: any) {
  return resolveRouteLocations(p, async name => {
    const location = locations[name];
    if (!location) return undefined;
    const [districtId, city, district] = location;
    return { districtId, districtName: district || city, districtType: district ? 'County' : 'City',
      parents: [{ districtName: '西藏', districtType: 'Province' },
        ...(district ? [{ districtName: city, districtType: 'City' }] : [])] };
  });
}

async function product() {
  const p = { basicInfo: { meetingCity: '拉萨', destinationCity: '拉萨', province: '西藏', userIdea: source.userIdea },
    itinerary: source.days.map((day: any) => ({ day: day.day, title: day.names.join(' · '),
      spots: day.names.map((name: string) => ({ name, kind: 'attraction' })) })), diagnostics: {} as any };
  p.diagnostics.routeLocations = await resolveLocations(p);
  return p;
}

test('拉萨27d3fe9a：佩枯措按原路线行政查询匹配日喀则，不回退接团城市', async () => {
  const p = await product(), day = p.itinerary[2];
  const poi = candidate('佩枯错', 85085, '日喀则', '吉隆');
  const context = buildPoiContextForItineraryDay(p, '拉萨', day, '佩枯措');
  assert.equal(isPlanningPoiCandidateInContext(poi, context, p, '佩枯措', [poi]), true);
  assert.equal(p.basicInfo.destinationCity, '拉萨');
});

test('拉萨27d3fe9a：第6天看点不是仲巴之后的有序路段，冈仁波齐仍在阿里', async () => {
  const p = await product(), day = p.itinerary[5];
  assert.deepEqual(routeLocationsForSpot(p, day, '冈仁波齐'), []);
  const poi = candidate('冈仁波齐', 10758151, '阿里', '普兰');
  const context = buildPoiContextForItineraryDay(p, '拉萨', day, '冈仁波齐');
  assert.equal(isPlanningPoiCandidateInContext(poi, context, p, '冈仁波齐', [poi]), true);
  Object.assign(day.spots.find((spot: any) => spot.name === '冈仁波齐'), poi);
  assert.deepEqual(routeLocationBlockers(p), []);
});

/** 按真实验收回读绑定锚点城市内的 POI，作为跨地州景点的路线走廊参考。 */
function bindAnchorReferences(p: any) {
  const bindings = JSON.parse(readFileSync(new URL('../fixtures/lhasa-poi-regression/final-bindings.json', import.meta.url), 'utf8'));
  for (const binding of bindings) {
    const day = p.itinerary[binding.day - 1];
    const anchorCities = new Set(p.diagnostics.routeLocations.filter((node: any) => node.day === binding.day).map((node: any) => node.city));
    const spot = day.spots.find((item: any) => item.name === binding.name);
    if (spot && anchorCities.has(binding.city)) Object.assign(spot, candidate(binding.poiName, binding.poiId, binding.city, binding.district));
  }
}

test('拉萨27d3fe9a：重复看点不丢失主路线位置，未闭合路段不排除明确命名的跨城景点', async () => {
  const p = await product(), day = p.itinerary[3];
  bindAnchorReferences(p);
  const poi = candidate('冈仁波齐', 10758151, '阿里', '普兰');
  const context = buildPoiContextForItineraryDay(p, '拉萨', day, '冈仁波齐');
  assert.equal(isPlanningPoiCandidateInContext(poi, context, p, '冈仁波齐', [poi]), true);
  assert.equal(isPlanningPoiCandidateInContext({ ...poi, province: '四川' }, context, p, '冈仁波齐', [poi]), false);
});

test('拉萨27d3fe9a：原路线回执失效后，旧同省绑定不能沿用地域授权', async () => {
  const p = await product(), day = p.itinerary[4];
  Object.assign(day.spots.find((spot: any) => spot.name === '托林寺'), candidate('托林寺', 78551, '阿里', '札达'));
  assert.deepEqual(routeLocationBlockers(p), []);
  // 生成标题不是路线事实，不得使原路线的 native 行政回执过期。
  day.title += '新方案';
  assert.deepEqual(routeLocationBlockers(p), []);
  // 运营原路线真正变更时，旧 sourceRoute 不再匹配，必须重新核验。
  p.basicInfo.userIdea = p.basicInfo.userIdea.replace('塔钦--札达--塔钦', '塔钦--日喀则--塔钦');
  assert.equal(routeLocationBlockers(p).length, 1);
});

test('拉萨27d3fe9a：原文地点与具备营业收据的真实官方别名相符时，当前路线回执允许地域复核', async () => {
  const p = await product();
  Object.assign(p.itinerary[1].spots.find((spot: any) => spot.name === '珠峰绒布冰川遗迹'),
    candidate('绒布冰川', 76353, '日喀则', '定日'));
  assert.deepEqual(routeLocationBlockers(p), []);
});

test('拉萨27d3fe9a：已匹配的珠峰/洛子峰/珠穆朗玛峰/五彩沙丘不因官方名尾缀或别名残留地域待处理项', async () => {
  const p = await product();
  const bindings: Array<[string, string, number, string, string]> = [
    ['珠峰', '珠峰景区', 88954632, '日喀则', '定日'],
    ['洛子峰', '洛子I峰', 85087, '日喀则', '定日'],
    ['珠穆朗玛峰风景区', '珠穆朗玛峰', 76352, '日喀则', '定日'],
    ['五彩沙丘', '仲巴县五彩沙漠', 23423947, '日喀则', '仲巴'],
  ];
  for (const [name, poiName, poiId, city, district] of bindings) {
    const day = p.itinerary.find((item: any) => item.spots.some((spot: any) => spot.name === name));
    Object.assign(day.spots.find((spot: any) => spot.name === name), candidate(poiName, poiId, city, district));
  }
  assert.deepEqual(routeLocationBlockers(p), []);
  const sand = p.itinerary[5].spots.find((spot: any) => spot.name === '五彩沙丘');
  sand.province = '四川';
  assert.deepEqual(routeLocationBlockers(p).map((issue: any) => issue.label), ['第6天景点地域：五彩沙丘']);
});

test('无序看点不能仅凭当天途经一个外省城市取得跨省绑定许可', async () => {
  const p = await product(), day = p.itinerary[4];
  p.basicInfo.province = '四川';
  const poi = candidate('托林寺', 78551, '阿里', '札达');
  const context = buildPoiContextForItineraryDay(p, '拉萨', day, '托林寺');
  assert.equal(isPlanningPoiCandidateInContext(poi, context, p, '托林寺', [poi]), false);
});

test('跨省有序路线的单侧锚点不能被接团省份的同名候选覆盖', async () => {
  const p = await product(), day = p.itinerary[3];
  p.basicInfo.province = '四川';
  const poi = { ...candidate('冈仁波齐', 10758151, '成都', '武侯'), province: '四川' };
  const context = buildPoiContextForItineraryDay(p, '拉萨', day, '冈仁波齐');
  assert.equal(isPlanningPoiCandidateInContext(poi, context, p, '冈仁波齐', [poi]), false);
});

test('拉萨27d3fe9a：山南/阿里的同省跨地州景点不被日喀则路线锚点误判为地域缺失', async () => {
  const p = await product();
  bindAnchorReferences(p);
  const bind = (dayIndex: number, name: string, poiName: string, poiId: number, city: string, district: string) => {
    const spot = p.itinerary[dayIndex].spots.find((item: any) => item.name === name);
    assert.ok(spot, `缺少原路线景点 ${name}`);
    Object.assign(spot, candidate(poiName, poiId, city, district));
  };
  // 第1天：羊卓雍措、普莫雍措属山南，原路线锚点只有拉萨与日喀则。
  bind(0, '羊卓雍措', '羊卓雍错', 82105, '山南', '浪卡子');
  bind(0, '普莫雍措', '普莫雍错', 94904, '山南', '浪卡子');
  // 第4天：塔尔钦属阿里普兰，但原路线只能解析出萨嘎一个日喀则锚点。
  bind(3, '公珠措', '公珠错', 91992, '阿里', '普兰');
  bind(3, '冈仁波齐', '冈仁波齐', 10758151, '阿里', '普兰');
  bind(3, '玛旁雍措', '玛旁雍措', 78548, '阿里', '普兰');
  bind(3, '拉昂措', '拉昂错', 85599, '阿里', '普兰');
  assert.deepEqual(routeLocationBlockers(p), []);
  // 同省同名异城：坐标落在林芝（离当日路线走廊数百公里）时必须阻塞。
  const yamdrok = p.itinerary[0].spots.find((item: any) => item.name === '羊卓雍措');
  const original = { latitude: yamdrok.latitude, longitude: yamdrok.longitude };
  Object.assign(yamdrok, { latitude: 29.65, longitude: 94.36 });
  assert.deepEqual(routeLocationBlockers(p).map((issue: any) => issue.label), ['第1天景点地域：羊卓雍措']);
  // 缺坐标即缺证据，同样阻塞。
  delete yamdrok.latitude; delete yamdrok.longitude;
  assert.deepEqual(routeLocationBlockers(p).map((issue: any) => issue.label), ['第1天景点地域：羊卓雍措']);
  Object.assign(yamdrok, original);
  assert.deepEqual(routeLocationBlockers(p), []);
  // 跨省仍是硬门禁：把公珠措改成四川候选后必须重新阻塞。
  p.itinerary[3].spots.find((item: any) => item.name === '公珠措').province = '四川';
  assert.deepEqual(routeLocationBlockers(p).map((issue: any) => issue.label), ['第4天景点地域：公珠措']);
});

test('拉萨27d3fe9a：真实保存的32个绑定与真实行政回执复核后无地域或身份阻塞', async () => {
  const p = await product();
  const bindings = JSON.parse(readFileSync(new URL('../fixtures/lhasa-poi-regression/final-bindings.json', import.meta.url), 'utf8'));
  for (const binding of bindings) {
    const day = p.itinerary[binding.day - 1];
    let spot = day.spots.find((item: any) => item.name === binding.name);
    // 「羊卓雍湖」「冈仁波齐山体冰川遗迹」是运营恢复的看点标签，不在主路线名里。
    if (!spot) {
      spot = { name: binding.name, kind: 'attraction' };
      day.spots.push(spot);
    }
    Object.assign(spot, {
      poiName: binding.poiName, poiId: binding.poiId,
      ...(binding.province ? { province: binding.province } : {}),
      ...(binding.city ? { city: binding.city } : {}),
      ...(binding.district ? { district: binding.district } : {}),
      ...at(binding.poiId),
    });
  }
  // 恢复的两个看点标签改变了当日 routeKey，按真实顺序重新解析行政回执。
  p.diagnostics.routeLocations = await resolveLocations(p);
  assert.deepEqual(poiIdentityBlockers(p), []);
  assert.deepEqual(routeLocationBlockers(p), []);
  // 目录没有可替代地点、必须由运营决定的六个槽位仍保持未绑定。
  assert.deepEqual(p.itinerary.flatMap((day: any) => day.spots.filter((spot: any) => !spot.poiId).map((spot: any) => spot.name)),
    ['库拉岗日冰川', '巴松村', '希夏邦马峰冰川群', '拉普古村寨', '索比拉亚山', '桑桑大草原']);
});

test('拉萨27d3fe9a：复核已绑定 POI 时，同省跨地州的正确绑定不被判成明确错城', async () => {
  const p = await product();
  const cases: Array<[number, string, string, number, string, string]> = [
    [0, '羊卓雍措', '羊卓雍错', 82105, '山南', '浪卡子'],
    [0, '普莫雍措', '普莫雍错', 94904, '山南', '浪卡子'],
    [3, '公珠措', '公珠错', 91992, '阿里', '普兰'],
  ];
  for (const [dayIndex, name, poiName, poiId, city, district] of cases) {
    const day = p.itinerary[dayIndex];
    const spot = day.spots.find((item: any) => item.name === name);
    Object.assign(spot, candidate(poiName, poiId, city, district));
    const context = buildPoiContextForItineraryDay(p, '拉萨', day, name);
    assert.equal(hasDefinitePoiLocationConflict({ ...spot, index: 0, selectable: true, textFields: [] }, context, p, name), false, name);
  }
  // 跨省候选仍是明确冲突：复核必须清掉四川的山南同名候选。
  const day = p.itinerary[0], spot = day.spots.find((item: any) => item.name === '羊卓雍措');
  spot.province = '四川';
  spot.city = '成都';
  const context = buildPoiContextForItineraryDay(p, '拉萨', day, '羊卓雍措');
  assert.equal(hasDefinitePoiLocationConflict({ ...spot, index: 0, selectable: true, textFields: [] }, context, p, '羊卓雍措'), true);
});
