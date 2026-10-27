import assert from 'node:assert/strict';
import test from 'node:test';
import { lhasaFixture, source } from '../fixtures/lhasa-poi-regression/harness.js';
import { DbOrchestratorRuntime } from '../../src/main/planning/runtime.js';
import { enrichItineraryPois } from '../../src/main/planning/poi-enrichment.js';
import { computeReadiness } from '../../src/main/readiness.js';

test('拉萨27d3fe9a：空白产品生成后，佩枯措查询、绑定、独立回读一致', async t => {
  const f = await lhasaFixture(t);
  const before = f.read().detail.product.itinerary!.map(day => day.spots!.map(spot => spot.name));
  const result = JSON.parse((await f.execute('query_poi', { keyword: '佩枯错', day: 3, spotName: '佩枯措' })).content);
  assert.equal(result.usableDecision.kind, 'auto');
  assert.equal(result.candidates[0].usable, true);
  assert.deepEqual(result.scope, { day: 3, spotName: '佩枯措' });
  await f.execute('select_itinerary_poi', { day: 3, spotName: '佩枯措', queryKeyword: '佩枯错', poiId: 85085 });
  const { detail, snapshot } = f.read();
  const spot = detail.product.itinerary![2]!.spots!.find(spot => spot.name === '佩枯措')!;
  assert.equal(spot.poiId, 85085);
  assert.equal(spot.city, '日喀则');
  assert.equal(spot.district, '吉隆');
  assert.equal(detail.product.basicInfo!.userIdea, source.userIdea);
  assert.equal(detail.product.basicInfo!.meetingCity, '拉萨');
  assert.equal(detail.product.basicInfo!.destinationCity, '拉萨');
  assert.deepEqual(detail.product.operations!.trafficLine, { enabled: true, variants: ['flightRoundTrip', 'trainRoundTrip'] });
  assert.deepEqual(detail.product.itinerary!.map(day => day.spots!.map(spot => spot.name)), before);
  assert.equal(snapshot?.pendingApproval, undefined);
});

test('拉萨27d3fe9a：跨日同名查询须指定槽位，第4、6天冈仁波齐均可绑定阿里候选', async t => {
  const f = await lhasaFixture(t);
  const unscoped = JSON.parse((await f.execute('query_poi', { keyword: '冈仁波齐' })).content);
  assert.notEqual(unscoped.usableDecision.kind, 'auto');
  assert.equal(unscoped.scope, null);
  assert.ok(unscoped.candidates.every((candidate: any) => !candidate.usable));
  // 冈仁波齐在阿里，第4、6天路线锚点只有日喀则：没有锚点城市已绑定景点作走廊参考时不能放行。
  const early = JSON.parse((await f.execute('query_poi', { keyword: '冈仁波齐', day: 4, spotName: '冈仁波齐' })).content);
  assert.notEqual(early.usableDecision.kind, 'auto');
  // 按真实流程先绑定锚点城市内的景点（坐标来自平台），它们连成的路线走廊再证明阿里景点。
  const wetland = { poiName: '马泉河湿地', poiId: 145595738, province: '西藏', city: '日喀则', district: '仲巴',
    latitude: 29.89225, longitude: 83.722982 };
  const product = structuredClone(f.read().detail.product);
  for (const day of [4, 6]) {
    const spots = product.itinerary![day - 1]!.spots!;
    const slot = spots.find(spot => spot.name === '马泉河湿地') ?? spots[spots.push({ name: '马泉河湿地', kind: 'attraction' } as any) - 1]!;
    Object.assign(slot, wetland);
  }
  f.mutations.replace(f.id, product);
  // 第5天锚点是札达（阿里）：托林寺按锚点城市直接通过，经生产工具绑定后带上平台坐标。
  await f.execute('select_itinerary_poi', { day: 5, spotName: '托林寺', poiId: 78551 });
  for (const day of [4, 6]) {
    const result = JSON.parse((await f.execute('query_poi', { keyword: '冈仁波齐', day, spotName: '冈仁波齐' })).content);
    assert.equal(result.usableDecision.kind, 'auto');
    await f.execute('select_itinerary_poi', { day, spotName: '冈仁波齐', poiId: 10758151 });
    assert.equal(f.read().detail.product.itinerary![day - 1]!.spots!.find(spot => spot.name === '冈仁波齐')!.city, '阿里');
  }
});

test('拉萨27d3fe9a：外省候选在查询即标不可绑定，选择同样拒绝且无审批', async t => {
  const f = await lhasaFixture(t, records => {
    Object.assign(records.poi.佩枯错.district, { districtName: '武侯', parents: [
      { districtName: '四川', districtType: 'Province' }, { districtName: '成都', districtType: 'City' },
    ] });
  });
  const result = JSON.parse((await f.execute('query_poi', { keyword: '佩枯错', day: 3, spotName: '佩枯措' })).content);
  assert.notEqual(result.usableDecision.kind, 'auto');
  assert.ok(result.candidates.every((candidate: any) => !candidate.usable));
  await assert.rejects(f.execute('select_itinerary_poi', { day: 3, spotName: '佩枯措', queryKeyword: '佩枯错', poiId: 85085 }), /地域约束不匹配/);
  assert.equal(f.read().detail.product.itinerary![2]!.spots!.find(spot => spot.name === '佩枯措')!.poiId, null);
  assert.equal(f.read().snapshot?.pendingApproval, undefined);
});

test('拉萨27d3fe9a：暂停营业在查询及绑定两处均拒绝', async t => {
  const f = await lhasaFixture(t, records => { records.poi.佩枯错.poiId = 85095; }, 'suspended');
  const result = JSON.parse((await f.execute('query_poi', { keyword: '佩枯错', day: 3, spotName: '佩枯措' })).content);
  assert.notEqual(result.usableDecision.kind, 'auto');
  await assert.rejects(f.execute('select_itinerary_poi', { day: 3, spotName: '佩枯措', queryKeyword: '佩枯错', poiId: 85095 }), /暂停营业/);
});

for (const field of ['district', 'city'] as const) test(`拉萨27d3fe9a：旧绑定缺${field}且当前查询失败，保留身份并持久化核验阻塞`, async t => {
  const f = await lhasaFixture(t);
  await f.execute('select_itinerary_poi', { day: 5, spotName: '托林寺', poiId: 78551 });
  const current = f.read().detail;
  const product = structuredClone(current.product);
  delete product.itinerary![4]!.spots!.find(spot => spot.name === '托林寺')![field];
  f.mutations.replace(f.id, product);
  const runtime = new DbOrchestratorRuntime(f.db);
  runtime.resolvePoiSelection = async () => { throw new Error('固定查询超时'); };
  runtime.getPoiAvailabilities = async ids => new Map(ids.map(id => [id, { status: 'available' }]));
  await enrichItineraryPois({ localProductId: f.id, destination: '拉萨', runtime,
    reviewCompletePois: true, persistedTaskKeys: new Set() });
  const { detail, snapshot } = f.read();
  assert.equal(detail.product.itinerary![4]!.spots!.find(spot => spot.name === '托林寺')!.poiId, 78551);
  const task = detail.researchTasks.find(task => task.label.includes('托林寺'))!;
  assert.equal(task.state, 'researching');
  assert.match(task.detail!, /本轮 POI 核验未完成/);
  assert.equal(computeReadiness({ product: detail.product, researchTasks: detail.researchTasks }).ready, false);
  assert.equal(snapshot?.pendingApproval, undefined);
});
