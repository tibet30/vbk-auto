import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parsePoiSuggestPayload } from '../../src/main/infrastructure/poi-suggest/parse.js';
import { resolvePlanningPoiAutoSelection } from '../../src/main/planning/poi-auto-selection.js';
import { buildPoiContextForItineraryDay } from '../../src/main/planning/poi-context.js';
import { resolveRouteLocations } from '../../src/main/planning/route-location-resolution.js';
import { dedupeProductItineraryPois } from '../../src/shared/itinerary-poi-deduplication.js';
import { poiCandidatesForAvailability } from '../../src/main/agent/poi-query-compact.js';
import { isCompatiblePoiIdentity, poiIdentityBlockers } from '../../src/shared/poi-candidate-identity.js';

const read = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/lhasa-poi-regression/${name}`, import.meta.url), 'utf8'));
const source = read('route.json');
const rows = read('live-candidates.json') as Array<{ keyword: string; status: number; payload: any }>;
const native = read('queries.json').administrative;
const detail = (keyword: string) => {
  const row = rows.find(row => row.keyword === keyword);
  assert.ok(row, `缺少真实候选回放：${keyword}`);
  return parsePoiSuggestPayload(keyword, structuredClone(row.payload), row.status, { province: '西藏' });
};

test('山峰与独立冰川不能互相代替，明确别名仍保留', () => {
  assert.equal(isCompatiblePoiIdentity('希夏邦马峰', '希夏邦马峰冰川群'), false);
  assert.equal(isCompatiblePoiIdentity('库拉岗日冰川', '库拉岗日雪山'), false);
  assert.equal(isCompatiblePoiIdentity('希夏邦马', '希夏邦马峰'), true);
});
async function product() {
  const p = { basicInfo: { meetingCity: '拉萨', destinationCity: '拉萨', province: '西藏', userIdea: source.userIdea },
    itinerary: source.days.map((day: any) => ({ day: day.day, title: day.names.join(' · '),
      spots: day.names.map((name: string) => ({ name, kind: 'attraction', relation: 'and', poiId: null, poiName: null })) })),
    diagnostics: {} as any };
  p.diagnostics.routeLocations = await resolveRouteLocations(p, async name => {
    assert.ok(Object.hasOwn(native, name), `缺行政回放：${name}`);
    return native[name] ?? undefined;
  });
  return p;
}

/** 跨地州景点要靠锚点城市内已绑定、带平台坐标的景点作路线走廊参考（真实流程同轮先绑定它们）。 */
function bindAnchorReferences(p: any) {
  const coordinates = read('coordinates.json').points;
  for (const binding of read('final-bindings.json')) {
    const anchorCities = new Set(p.diagnostics.routeLocations.filter((node: any) => node.day === binding.day).map((node: any) => node.city));
    const spot = p.itinerary[binding.day - 1].spots.find((item: any) => item.name === binding.name);
    if (spot && anchorCities.has(binding.city) && coordinates[binding.poiId]) Object.assign(spot, {
      poiName: binding.poiName, poiId: binding.poiId, province: binding.province, city: binding.city, district: binding.district,
      latitude: coordinates[binding.poiId].latitude, longitude: coordinates[binding.poiId].longitude,
    });
  }
}

for (const day of [4, 6]) for (const [name, query, id] of [['拉昂措', '拉昂错', 85599], ['公珠措', '公珠错', 91992]] as const) {
  test(`真实100候选：第${day}天${name}按措错等价选择主POI，不由AI猜其他湖`, async () => {
    const p = await product();
    bindAnchorReferences(p);
    const result = await resolvePlanningPoiAutoSelection({ localProductId: 'isolated', keyword: query, product: p,
      context: buildPoiContextForItineraryDay(p, '拉萨', p.itinerary[day - 1], name), detail: detail(query),
      checkAvailability: async () => ({ status: 'available' }),
      disambiguate: async () => { throw new Error('唯一官方别名不应依赖模型猜选'); } });
    assert.equal(result.status, 'available');
    assert.equal(result.match?.poiId, id);
    assert.equal(result.match?.city, '阿里');
  });
}

test('真实100候选：没有锚点城市参考坐标时，跨地州湖泊不凭同省与原文点名放行', async () => {
  const p = await product();
  const result = await resolvePlanningPoiAutoSelection({ localProductId: 'isolated', keyword: '公珠错', product: p,
    context: buildPoiContextForItineraryDay(p, '拉萨', p.itinerary[3], '公珠措'), detail: detail('公珠错'),
    checkAvailability: async () => ({ status: 'available' }), disambiguate: async () => ({ pickedText: null, confidence: 0 }) });
  assert.equal(result.status, 'uncertain');
  assert.equal(result.reason, 'location_mismatch');
});

test('真实候选：古格王朝选择古格王国遗址，查询可用项不把红殿当主景点', async () => {
  const p = await product();
  const d = detail('古格王朝');
  const result = await resolvePlanningPoiAutoSelection({ localProductId: 'isolated', keyword: '古格王朝', product: p,
    context: buildPoiContextForItineraryDay(p, '拉萨', p.itinerary[4], '古格王朝'), detail: d,
    checkAvailability: async () => ({ status: 'available' }),
    disambiguate: async ({ candidates }) => ({ pickedText: candidates.find(c => c.text.includes('红殿'))?.text ?? null, confidence: 0.99 }) });
  assert.equal(result.match?.poiId, 10758152);
  const candidates = poiCandidatesForAvailability({ keyword: '古格王朝', detail: d });
  assert.ok(!candidates.some(c => c.poiId === 145360250));
  assert.ok(candidates.some(c => c.poiId === 10758152));
});

test('真实候选的反向验证：同名多ID、外省和暂停营业均不回填，也不借观景台兜底', async () => {
  const p = await product(), context = buildPoiContextForItineraryDay(p, '拉萨', p.itinerary[3], '拉昂措');
  const d = detail('拉昂错');
  const main = d.candidates.find(c => c.poiId === 85599)!;
  for (const mode of ['ambiguous', 'foreign', 'suspended'] as const) {
    const candidates = mode === 'ambiguous' ? [main, { ...main, poiId: 85599001 }]
      : mode === 'foreign' ? [{ ...main, province: '四川', city: '成都' }] : [main];
    const result = await resolvePlanningPoiAutoSelection({ localProductId: 'isolated', keyword: '拉昂错', context, product: p,
      detail: { ...d, best: main, candidates }, checkAvailability: async () => ({ status: mode === 'suspended' ? 'suspended' : 'available' }),
      disambiguate: async () => ({ pickedText: `${main.poiName} · 西藏/阿里/普兰`, confidence: 0.99 }) });
    assert.equal(result.match, undefined, mode);
  }
});

test('主子身份门禁不会因旧绑定ID、旧任务确认或模型高置信度而放行', async () => {
  const p = await product(), day = p.itinerary[4];
  Object.assign(day.spots.find((s: any) => s.name === '古格王朝'), { poiId: 145360250, poiName: '古格王朝遗址-红殿' });
  assert.equal(poiIdentityBlockers(p).length, 1);
  const d = detail('古格王朝');
  const child = d.candidates.find(c => c.poiId === 145360250)!;
  const result = await resolvePlanningPoiAutoSelection({ localProductId: 'isolated', keyword: '古格王朝', product: p,
    context: buildPoiContextForItineraryDay(p, '拉萨', day, '古格王朝'), detail: { ...d, best: child, candidates: [child] },
    confirmedPoiId: 145360250, checkAvailability: async () => ({ status: 'available' }) });
  assert.equal(result.match, undefined);
  const explicitlyRequested = { basicInfo: { province: '西藏', userIdea: 'D1 古格王朝遗址-红殿' },
    itinerary: [{ day: 1, spots: [{ name: '古格王朝遗址-红殿' }] }] };
  const exact = await resolvePlanningPoiAutoSelection({ localProductId: 'isolated', keyword: '古格王朝遗址-红殿', product: explicitlyRequested,
    context: { destinationCity: '阿里', province: '西藏' }, detail: { ...d, best: child, candidates: [child] },
    checkAvailability: async () => ({ status: 'available' }) });
  assert.equal(exact.match?.poiId, 145360250, '原文明确要求子景点时仍允许该子景点');
});

test('真实候选：佩枯错主湖优先，只有观景台时不能自动代替原湖泊', async () => {
  const p = await product();
  for (const [query, expected] of [['佩枯措', undefined], ['佩枯错', 85085]] as const) {
    const d = detail(query);
    const result = await resolvePlanningPoiAutoSelection({ localProductId: 'isolated', keyword: query, product: p,
      context: buildPoiContextForItineraryDay(p, '拉萨', p.itinerary[2], '佩枯措'), detail: d,
      checkAvailability: async () => ({ status: 'available' }),
      disambiguate: async ({ candidates }) => ({ pickedText: candidates.find(c => c.text.includes('佩枯措观景台'))?.text ?? null, confidence: 0.99 }) });
    assert.equal(result.match?.poiId, expected);
  }
});

for (const [dayNumber, name, id, officialName] of [
  [2, '珠峰绒布冰川遗迹', 76353, '绒布冰川'],
] as const) {
  test(`真实候选：第${dayNumber}天${name}仅以明确同名别名匹配${officialName}`, async () => {
    const p = await product();
    const d = detail(name);
    const official = d.candidates.find(candidate => candidate.poiId === id);
    assert.ok(official, `真实候选缺少 ${officialName}`);
    const result = await resolvePlanningPoiAutoSelection({ localProductId: 'isolated', keyword: name, product: p,
      context: buildPoiContextForItineraryDay(p, '拉萨', p.itinerary[dayNumber - 1], name),
      detail: { ...d, best: official, candidates: [official] },
      checkAvailability: async () => ({ status: 'available' }) });
    assert.equal(result.match?.poiId, id);
    assert.equal(result.match?.poiName, officialName);
  });
}

test('真实原路线：同ID的冰川群与主峰称呼保存后都保留，原日序和or选项不合并', async () => {
  const p = await product(), day = p.itinerary[2];
  const before = day.spots.map((spot: any) => spot.name);
  for (const spot of day.spots) if (spot.name.includes('希夏邦马')) Object.assign(spot, { poiName: '希夏邦马峰', poiId: 85090 });
  const after = dedupeProductItineraryPois(p);
  assert.deepEqual(after.itinerary[2].spots.map((spot: any) => spot.name), before);
});

test('真实候选：目录没有同形地点时判为身份不符，不把无同名候选误报成地域不一致', async () => {
  const p = await product();
  for (const [dayNumber, name] of [[1, '库拉岗日冰川'], [3, '巴松村'], [3, '希夏邦马峰冰川群']] as const) {
    const result = await resolvePlanningPoiAutoSelection({
      localProductId: 'isolated', keyword: name, product: p,
      context: buildPoiContextForItineraryDay(p, '拉萨', p.itinerary[dayNumber - 1], name),
      detail: detail(name),
      checkAvailability: async () => ({ status: 'available' }),
      disambiguate: async () => ({ pickedText: null, confidence: 0 }),
    });
    assert.equal(result.status, 'uncertain', name);
    assert.equal(result.reason, 'identity_mismatch', name);
  }
  // 真正的同名跨城候选仍归为地域不一致，运营需要改当天范围而不是改名。
  const peiku = await resolvePlanningPoiAutoSelection({
    localProductId: 'isolated', keyword: '佩枯措', product: p,
    context: buildPoiContextForItineraryDay(p, '拉萨', p.itinerary[2], '佩枯措'),
    detail: {
      ...detail('佩枯错'),
      candidates: detail('佩枯错').candidates.map(candidate => ({ ...candidate, city: '成都', province: '四川' })),
    },
    checkAvailability: async () => ({ status: 'available' }),
    disambiguate: async () => ({ pickedText: null, confidence: 0 }),
  });
  assert.equal(peiku.reason, 'location_mismatch');
});
