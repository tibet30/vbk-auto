import assert from 'node:assert/strict';
import test from 'node:test';
import { itineraryContentDigest, itineraryContentDifferencePaths } from '../../src/main/automation/ctrip/itinerary-review/evidence.js';
import { setup } from '../operations/itinerary-review-unlock.fixture.js';

const original = () => ({ tourDailyDescriptions: [{ title: '龙江第一湾', isAiRcmdTitle: false, isEditAfterAi: false,
  tourDailyInfos: [{ activeType: { key: 3 }, description: '保留原路线', duration: 120,
    tourDailyPois: [{ relation: 'and', costInclude: { key: 1 }, duration: 60,
      poi: { poiId: 91861, poiName: '龙江第一湾风景区' }, aiAdjustPoiDetailInfo: null }] },
  { activeType: { key: 1 }, tourDailyHotels: [{ hotel: { hotelId: 0, hotelName: '自选酒店', grade: { key: -4 } } }] }],
}] });

function normalized() {
  const value = original() as any;
  const day = value.tourDailyDescriptions[0];
  day.isAiRcmdTitle = true; day.isEditAfterAi = true;
  day.tourDailyInfos[0].tourDailyPois[0].aiAdjustPoiDetailInfo = { suggestedPoiName: '平台建议', reason: 'AI推荐标记' };
  return value;
}

test('check8 新增的 AI 元数据不被误判为行程改写', () => {
  assert.equal(itineraryContentDigest(original()), itineraryContentDigest(normalized()));
  assert.deepEqual(itineraryContentDifferencePaths(original(), normalized()), []);
});

test('忽略 AI 元数据后仍严格保护实际行程和同名未知字段', () => {
  const mutate = [
    (day: any) => { day.title = '换了一条路线'; },
    (day: any) => { day.tourDailyInfos.reverse(); },
    (day: any) => { day.tourDailyInfos[0].description = '已改写'; },
    (day: any) => { day.tourDailyInfos[0].activeType.key = 9; },
    (day: any) => { day.tourDailyInfos[0].duration = 1; },
    (day: any) => { day.tourDailyInfos[0].tourDailyPois[0].poi.poiId = 86672; },
    (day: any) => { day.tourDailyInfos[0].tourDailyPois[0].poi.poiName = '北极村'; },
    (day: any) => { day.tourDailyInfos[0].tourDailyPois[0].relation = 'or'; },
    (day: any) => { day.tourDailyInfos[0].tourDailyPois[0].costInclude.key = 2; },
    (day: any) => { day.tourDailyInfos[0].tourDailyHotels = [{ hotel: { hotelId: 123, hotelName: '指定酒店' } }]; },
    (day: any) => { day.tourDailyInfos[0].isAiRcmdTitle = true; },
    (day: any) => { day.aiAdjustPoiDetailInfo = '未知位置'; },
  ];
  for (const change of mutate) {
    const value = normalized(); change(value.tourDailyDescriptions[0]);
    assert.notEqual(itineraryContentDigest(original()), itineraryContentDigest(value));
    assert.ok(itineraryContentDifferencePaths(original(), value).length > 0);
  }
});

const metadataPaths = ['$.tourDailyDescriptions[0].isAiRcmdTitle', '$.tourDailyDescriptions[0].isEditAfterAi',
  '$.tourDailyDescriptions[0].tourDailyInfos[0].tourDailyPois[0].aiAdjustPoiDetailInfo'];

test('历史元数据误判只能在新鲜完整方案回读通过后恢复，并重新执行完整协议', async () => {
  const f = setup(); f.submitMode = 'digest-mismatch'; f.digestMismatchPaths = metadataPaths;
  const service = f.service(); const plan = await service.prepare('local');
  await assert.rejects(service.execute(plan.token!));
  const checks = f.verifyPlanCalls;
  const recovered = await f.service().refresh('local');
  assert.equal(recovered.status, 'requires_review'); assert.ok(f.verifyPlanCalls > checks);
  assert.equal(f.submitCalls, 1);
  f.submitMode = 'success';
  const retry = f.service(); const next = await retry.prepare('local');
  assert.equal((await retry.execute(next.token!)).verified, true); assert.equal(f.submitCalls, 2);
});

test('混入真实字段变化或完整方案回读失败时不恢复授权', async () => {
  for (const mismatch of [true, false]) {
    const f = setup(); f.submitMode = 'digest-mismatch';
    f.digestMismatchPaths = [...metadataPaths, ...(mismatch ? ['$.tourDailyDescriptions[0].title'] : [])];
    const service = f.service(); const plan = await service.prepare('local');
    await assert.rejects(service.execute(plan.token!));
    if (mismatch) assert.equal((await f.service().refresh('local')).status, 'uncertain');
    else { f.verifyPlanError = new Error('完整方案不一致'); await assert.rejects(f.service().refresh('local'), /完整方案不一致/); }
    assert.equal(f.persisted?.status, 'uncertain'); assert.equal(f.submitCalls, 1);
  }
});
