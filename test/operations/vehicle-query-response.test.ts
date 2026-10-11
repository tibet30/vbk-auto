import test from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { searchVehicleResourceGroups } from '../../src/main/operations/vehicle-resource/search.js';
import { firstResourceGroup } from '../../src/main/operations/vehicle-resource/parse.js';

// Contract captured read-only on 2026-10-11: HTTP 200, Ack=Success, resourceGroupDtos.
const group = { resourceGroupId: 2206177,
  resourceGroupName: '5座经济100+5座舒适150+7座200+9座250+12座350+14座350+19座450' };

function pageReturning(payload: unknown) {
  let calls = 0;
  const page = { nativeOnly: true, vbkSessionFetch: async (request: { endpoint: string; body: { resourceGroupName: string } }) => {
    calls++;
    assert.equal(request.endpoint, 'https://online.ctrip.com/restapi/soa2/15638/searchResourceGroup');
    assert.equal(request.body.resourceGroupName, '5座经济');
    return { status: 200, payload };
  } } as unknown as Page;
  return { page, calls: () => calls };
}

for (const nested of [false, true]) {
  test(`vehicle query accepts actual resourceGroupDtos contract (nested=${nested})`, async () => {
    const list = { resourceGroupDtos: [group], total: 1108 };
    const payload = { ResponseStatus: { Ack: 'Success', Errors: [] }, ...(nested ? { data: list } : list) };
    const harness = pageReturning(payload);
    const result = await searchVehicleResourceGroups(harness.page, '5座经济');
    assert.equal(result, payload);
    assert.deepEqual(firstResourceGroup(result), group);
    assert.equal(harness.calls(), 1);
  });
}

test('empty vehicle list is distinct from missing or invalid collection and business rejection', async () => {
  const empty = pageReturning({ ResponseStatus: { Ack: 'Success' }, resourceGroupDtos: [] });
  assert.equal(firstResourceGroup(await searchVehicleResourceGroups(empty.page, '5座经济')), undefined);
  for (const resourceGroupDtos of [undefined, null, {}]) {
    const harness = pageReturning({ ResponseStatus: { Ack: 'Success' }, resourceGroupDtos });
    await assert.rejects(searchVehicleResourceGroups(harness.page, '5座经济'), /资源集合字段缺失/);
    assert.equal(harness.calls(), 1);
  }
  const denied = pageReturning({ ResponseStatus: { Ack: 'Failure', Errors: [{ ErrorCode: '40010001', Message: '登录失效' }] },
    resourceGroupDtos: [group] });
  await assert.rejects(searchVehicleResourceGroups(denied.page, '5座经济'), /业务拒绝.*登录失效/);
});
