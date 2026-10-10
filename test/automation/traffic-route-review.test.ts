import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareRouteReviewDetail, submitTrafficRouteReview } from '../../src/main/automation/ctrip/traffic-line/route-review.ts';
import { buildFreeInfo } from '../../src/main/automation/ctrip/itinerary-api/info-builders.ts';

const detail = { tourInfoId: '419176955761066092', tourDailyDescriptions: [{ orderDay: 2, tourDailyInfos: [
  { activeType: { key: 7 }, takeTime: 0, description: '岐山美食体验' },
  { activeType: { key: 7 }, takeTime: 90, description: '已有时长' },
  { activeType: { key: 3 }, takeTime: 240, tourDailyPois: [{ poiId: 85218 }] },
] }] };

test('线路审核恢复保留原行程身份与内容，只使用明确提供的自由活动时长', () => {
  assert.throws(() => prepareRouteReviewDetail(detail), /缺少正数时长/);
  assert.throws(() => prepareRouteReviewDetail(detail, 0), /缺少正数时长/);
  const result = prepareRouteReviewDetail(detail, 60);
  assert.equal(result.tourInfoId, detail.tourInfoId);
  assert.deepEqual(result.tourDailyDescriptions[0].tourDailyInfos.map(i => i.takeTime), [60, 90, 240]);
  assert.equal(detail.tourDailyDescriptions[0].tourDailyInfos[0].takeTime, 0);
});

test('未授权审核时连只读调用也不会启动', async () => {
  let calls = 0;
  const page = { evaluate: async () => { calls++; } } as any;
  await assert.rejects(() => submitTrafficRouteReview(page, '1', {} as any), /尚未获得明确授权/);
  assert.equal(calls, 0);
});

test('自由活动默认安排一小时，保留明确提供的活动时长', () => {
  assert.equal(buildFreeInfo({ description: '美食体验', sort: 1 }).takeTime, 60);
  assert.equal(buildFreeInfo({ description: '美食体验', sort: 1, durationMinutes: 90 }).takeTime, 90);
  assert.throws(() => buildFreeInfo({ description: '美食体验', sort: 1, durationMinutes: 0 }), /必须大于0/);
});

test('真实协议恢复使用既有18位行程编号，提交后独立回读；再次恢复不重复提交', async () => {
  const tourId = detail.tourInfoId;
  const requests: Array<{ method: string; body: any }> = [];
  let routeId = 0;
  const page = { nativeOnly: true, evaluate: async () => { throw new Error('禁止旁路'); },
    vbkSessionFetch: async (request: any) => {
      const method = request.endpoint.split('/').pop();
      requests.push({ method, body: request.body });
      const relation = { productId: 1, tourInfoId: tourId, auditTourInfoId: tourId, main: true, auditStatus: { key: routeId ? 'A' : 'N' } };
      let fields: any;
      switch (method) {
        case 'getProductBaseInfo': fields = { baseInfo: { routeId } }; break;
        case 'getProductTourInfoList': fields = { tourInfos: [relation] }; break;
        case 'getTourDailyDetail.json': fields = { tourInfo: detail }; break;
        case 'checkTourDaily': fields = { productTourInfo: relation, tourDaily: request.body.tourDaily }; break;
        case 'saveTourDailyDetail.json': fields = { tourInfoId: tourId }; break;
        case 'saveProductTourInfo': routeId = 40004141; fields = {}; break;
        default: throw new Error(`意外调用 ${method}`);
      }
      return { status: 200, payload: { ResponseStatus: { Ack: 'Success' }, ...fields }, context: {} };
    } } as any;
  const options = { authorization: 'submit-route-review', missingFreeActivityMinutes: 60 } as const;
  const result = await submitTrafficRouteReview(page, '1', options);
  assert.equal(result.verified, true);
  assert.equal(result.tourInfoId, tourId);
  assert.equal(requests.find(r => r.method === 'saveProductTourInfo')!.body.tourInfo.tourInfoId, tourId);
  assert.equal(requests.find(r => r.method === 'checkTourDaily')!.body.saveType, 3);
  await submitTrafficRouteReview(page, '1', options);
  assert.equal(requests.filter(r => r.method === 'saveProductTourInfo').length, 1);
});

test('线路审核失败只续跑激活，历史阶段错标也能只读恢复资源异步提交', async () => {
  const { trafficRouteActivationCanResume, trafficSegmentSubmitNeedsRecovery } = await import('../../src/main/automation/ctrip/traffic-line/child-failure.ts');
  const progress: any = { variant: 'flightRoundTrip', completedStages: ['resourcesSaved', 'itinerarySaved', 'clausesSaved'], failedStage: 'activated', failureReason: '当前产品未匹配玩法线路', validationSubmittedAt: '2026-10-08T02:19:08Z' };
  assert.equal(trafficRouteActivationCanResume(progress), true);
  assert.equal(trafficRouteActivationCanResume({ ...progress, completedStages: ['resourcesSaved'] }), false);
  assert.equal(trafficSegmentSubmitNeedsRecovery(progress), false);
  const pending = { ...progress, failureReason: '子产品资源提交仍在 VBK 异步核验' };
  assert.equal(trafficRouteActivationCanResume(pending), false);
  assert.equal(trafficSegmentSubmitNeedsRecovery(pending), true);
  assert.equal(trafficSegmentSubmitNeedsRecovery({ ...pending, validationSubmittedAt: undefined }), false);
});
