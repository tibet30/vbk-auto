import assert from 'node:assert/strict';
import test from 'node:test';
import { lhasaFixture } from '../fixtures/lhasa-poi-regression/harness.js';
import { liveRuntime } from '../fixtures/lhasa-poi-regression/live-runtime.js';
import { enrichItineraryPois } from '../../src/main/planning/poi-enrichment.js';
import { refreshSatisfiedResearchTasks } from '../../src/main/operations/research-refresh.js';
import { computeReadiness } from '../../src/main/readiness.js';

const route = (p: any) => p.itinerary.map((day: any) => [day.day, day.spots.map((s: any) => [s.name, s.relation, s.timeOfDay]), day.hotelCity]);
const spot = (p: any, day: number, name: string) => p.itinerary[day - 1].spots.find((s: any) => s.name === name);

for (const corruptOldBindings of [false, true]) test(`真实候选保存回归：${corruptOldBindings ? '纠正旧主子/异湖错绑' : '从空白生成后补齐'}，原名原序与逐项核查保持一致`, async t => {
  const f = await lhasaFixture(t);
  const before = f.read().detail.product;
  const signature = route(before);
  assert.equal(before.itinerary!.flatMap(day => day.spots ?? []).length, 38);
  for (const [day, name] of [[1, '羊卓雍湖'], [3, '希夏邦马'], [4, '冈仁波齐山体冰川遗迹']] as const)
    assert.ok(spot(before, day, name), `原文槽位必须在匹配前独立保留：${name}`);
  f.db.addResearchTask(f.id, { label: '核查 希夏邦马 的 VBK POI 映射', type: 'vbk', detail: '本轮 POI 核验未完成：历史去重后遗留，必须重新核验原槽位。' });
  if (corruptOldBindings) {
    const p = structuredClone(before);
    for (const [day, name, poiName, poiId, city, district] of [
      [5, '古格王朝', '古格王朝遗址-红殿', 145360250, '阿里', '札达'],
      [6, '公珠措', '珠珠错', 144445835, '日喀则', '仲巴'],
      [3, '佩枯措', '佩枯措观景台', 152830907, '日喀则', '吉隆'],
      [1, '库拉岗日冰川', '库拉岗日雪山', 118481664, '山南', '洛扎'],
      [3, '希夏邦马峰冰川群', '希夏邦马峰', 85090, '日喀则', '聂拉木'],
    ] as const) Object.assign(spot(p, day, name), { poiName, poiId, province: '西藏', city, district });
    f.mutations.replace(f.id, p);
    assert.equal(computeReadiness({ product: f.read().detail.product, researchTasks: [] }).ready, false);
  }
  const { runtime } = liveRuntime(t, f);
  await enrichItineraryPois({ localProductId: f.id, destination: '拉萨', runtime, reviewCompletePois: true, persistedTaskKeys: new Set() });
  refreshSatisfiedResearchTasks(f.db, f.id);
  const { detail, snapshot } = f.read();
  assert.deepEqual(route(detail.product), signature);
  for (const [day, name, id] of [[4, '公珠措', 91992], [6, '公珠措', 91992], [4, '拉昂措', 85599], [6, '拉昂措', 85599],
    [5, '古格王朝', 10758152], [3, '佩枯措', 85085], [3, '希夏邦马', 85090]] as const) {
    assert.equal(spot(detail.product, day, name).poiId, id, `${day}:${name}`);
  }
  for (const [day, name] of [[1, '库拉岗日冰川'], [3, '希夏邦马峰冰川群']] as const) {
    assert.equal(spot(detail.product, day, name).poiId, null, '缺少对应粒度的可靠POI时继续阻塞，不借上级山峰代替');
  }
  const task = detail.researchTasks.find(task => task.label === '核查 希夏邦马 的 VBK POI 映射')!;
  assert.equal(task.state, 'confirmed');
  assert.match(task.evidence.at(-1)!.title, /itinerary-poi:verified/);
  assert.equal(detail.product.basicInfo!.userIdea, before.basicInfo!.userIdea);
  assert.equal(detail.product.basicInfo!.meetingCity, '拉萨');
  assert.equal(detail.product.basicInfo!.destinationCity, '拉萨');
  assert.deepEqual(detail.product.operations!.trafficLine, before.operations!.trafficLine);
  assert.equal(computeReadiness({ product: detail.product, researchTasks: detail.researchTasks }).ready, false);
  assert.equal(snapshot?.pendingApproval, undefined);
});

test('跨日同名逐项核验：第4天成功不能结清第6天查询失败的本轮核查', async t => {
  const f = await lhasaFixture(t);
  const p = f.read().detail.product;
  for (const day of [4, 6]) Object.assign(spot(p, day, '拉昂措'), {
    poiName: '拉昂错', poiId: 85599, province: '西藏', city: '阿里', district: '普兰',
  });
  f.mutations.replace(f.id, p);
  f.db.addResearchTask(f.id, { label: '核查 拉昂措 的 VBK POI 映射', type: 'vbk', detail: '本轮 POI 核验未完成：须逐日重新核验。' });
  const { runtime, overrides } = liveRuntime(t, f);
  const query = overrides.poi!;
  overrides.poi = async (keyword, context) => {
    if ((context as any)?.itineraryDay === 6 && /拉昂[措错]/u.test(keyword)) throw new Error('固定的第6天查询超时');
    return query(keyword, context);
  };
  await enrichItineraryPois({ localProductId: f.id, destination: '拉萨', runtime, reviewCompletePois: true, persistedTaskKeys: new Set() });
  refreshSatisfiedResearchTasks(f.db, f.id);
  const { detail, snapshot } = f.read();
  assert.equal(spot(detail.product, 6, '拉昂措').poiId, 85599, '无明确反证时保留旧身份');
  assert.equal(detail.researchTasks.find(t => t.label === '核查 拉昂措 的 VBK POI 映射')!.state, 'researching');
  assert.equal(snapshot?.pendingApproval, undefined);
});
