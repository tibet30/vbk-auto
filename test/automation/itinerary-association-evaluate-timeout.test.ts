import assert from 'node:assert/strict';
import test from 'node:test';
import { saveAssociationBeforeReadback } from '../../src/main/automation/ctrip/itinerary-api/association-save.js';
import { vbkSessionRequest } from '../../src/main/infrastructure/vbk-session-request.js';
import { ensureItineraryApi } from '../../src/main/automation/ctrip/itinerary-api.js';
import { baseProductNoHotel, callLog, clearRouteHandlers, installFetchStub, installHandlersForFieldMismatch,
  makeFakePage, resetCallLog, routeHandlers, uninstallFetchStub } from './itinerary-api.test-helpers.js';

test('real evaluate timeout proceeds to authoritative readback without resending the association', async () => {
  let writes = 0;
  await saveAssociationBeforeReadback(() => vbkSessionRequest({
    evaluate: async <T>() => { writes++; return new Promise<T>(() => {}); },
  }, { endpoint: 'https://example.test/save', body: {}, errorLabel: 'VBK 行程关联保存',
    browserRequestTimeoutMs: 1000, evaluateTimeoutMs: 5 }));
  assert.equal(writes, 1);
});

test('unrelated timeouts and business rejections still stop before readback', async () => {
  for (const message of ['VBK 行程详情保存BrowserView 执行超时（5ms）', 'VBK 行程关联保存失败：HTTP 500']) {
    const error = new Error(message);
    await assert.rejects(saveAssociationBeforeReadback(async () => { throw error; }), value => value === error);
  }
});

for (const mismatch of [false, true]) {
  test(`evaluate timeout reconciles through strict itinerary readback, mismatch=${mismatch}`, async () => {
    installFetchStub(); resetCallLog();
    installHandlersForFieldMismatch({ hotelName: () => '', otherDescription: () => '自由活动',
      serviceStart: '08:00', serviceEnd: '20:00', title: index => mismatch ? '错误标题' : index === 0 ? '第1天' : '第2天' });
    routeHandlers['/restapi/soa2/15638/saveProductTourInfo'] = () => {
      throw new Error('VBK 行程关联保存BrowserView 执行超时（20000ms）');
    };
    try {
      const action = () => ensureItineraryApi(makeFakePage() as any, baseProductNoHotel as any, '77035928');
      if (mismatch) await assert.rejects(action); else assert.equal((await action()).days, 2);
      assert.equal(callLog.filter(call => call.endpoint.endsWith('saveProductTourInfo')).length, 1);
      assert.equal(callLog.filter(call => call.endpoint.endsWith('getProductTourInfoList')).length, 2);
    } finally { clearRouteHandlers(); uninstallFetchStub(); }
  });
}
