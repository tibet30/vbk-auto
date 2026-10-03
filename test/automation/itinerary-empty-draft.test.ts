import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureItineraryApi } from '../../src/main/automation/ctrip/itinerary-api.js';
import { baseProductNoHotel, callLog, clearRouteHandlers, installFetchStub, installHandlersForFieldMismatch, makeFakePage, resetCallLog, routeHandlers, uninstallFetchStub } from './itinerary-api.test-helpers.js';

test.beforeEach(() => { resetCallLog(); installFetchStub(); });
test.afterEach(clearRouteHandlers);
test.after(uninstallFetchStub);

test('真正空关联首建使用平台模板与 check(2) 返回的精确 ID，随后完整回读', async () => {
  installHandlersForFieldMismatch({ hotelName: () => '', otherDescription: () => '自由活动', serviceStart: '08:00', serviceEnd: '20:00', title: i => i === 0 ? '第1天' : '第2天' });
  const id = '417899634191761447'; let saved = false;
  routeHandlers['/restapi/soa2/15638/getProductTourInfoList'] = () => ({
    ResponseStatus: { Ack: 'Success' }, templateId: 3,
    tourInfos: saved ? [{ tourInfoId: id, auditTourInfoId: id, auditTourInfoStatus: 1, auditStatus: { key: 'N', value: '未提交' } }] : [],
  });
  routeHandlers['/restapi/soa2/15638/checkTourDaily'] = body => ({
    ResponseStatus: { Ack: 'Success' }, tourDaily: JSON.stringify({ ...JSON.parse(body.tourDaily), tourInfoId: id }),
  });
  routeHandlers['/restapi/soa2/20049/saveTourDailyDetail.json'] = () => ({ ResponseStatus: { Ack: 'Success' }, tourInfoId: id });
  routeHandlers['/restapi/soa2/15638/saveProductTourInfo'] = () => { saved = true; return { ResponseStatus: { Ack: 'Success' }, success: true }; };
  const result = await ensureItineraryApi(makeFakePage() as any, baseProductNoHotel as any, '77035928');
  assert.equal(result.tourInfoId, id);
  const check = callLog.find(c => c.endpoint.endsWith('/checkTourDaily'))!.body;
  assert.equal(check.saveType, 2); assert.equal(check.productTourInfo.tourInfoId, 0);
  const input = JSON.parse(check.tourDaily);
  assert.equal(input.tourInfoId, 0); assert.equal(input.templateId, 3); assert.ok(input.template);
  assert.equal(input.isNew, true); assert.equal(input.isModify, false);
  assert.equal(callLog.filter(c => c.endpoint.endsWith('/checkTourDaily')).length, 1);
  assert.equal(callLog.some(c => c.endpoint.includes('calculateTourInfoScore')), false);
  const association = callLog.find(c => c.endpoint.endsWith('/saveProductTourInfo'))!.body;
  assert.equal(association.saveType, 2); assert.equal(association.tourInfo.tourInfoId, id);
  assert.deepEqual(association.tourInfo.auditStatus, { key: 'N', value: '未提交' });
});

test('缺失关联数组不能被当作空产品首建', async () => {
  installHandlersForFieldMismatch({ hotelName: () => '' });
  routeHandlers['/restapi/soa2/15638/getProductTourInfoList'] = () => ({ ResponseStatus: { Ack: 'Success' } });
  await assert.rejects(ensureItineraryApi(makeFakePage() as any, baseProductNoHotel as any, '77035928'), /响应缺 tourInfos/);
  assert.equal(callLog.some(c => /checkTourDaily|saveTourDailyDetail|saveProductTourInfo/.test(c.endpoint)), false);
});
