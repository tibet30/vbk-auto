import assert from 'node:assert/strict';
import test from 'node:test';
import { suggestPoiDetail } from '../../src/main/infrastructure/poi-suggest.js';
import { localizePoiListDistricts } from '../../src/main/infrastructure/suggest-district.js';

type Json = Record<string, any>;
const hierarchy = [
  { districtId: 396, districtName: '大兴安岭', districtType: 'City' },
  { districtId: 100055, districtName: '黑龙江', districtType: 'Province' },
];

function browserFor(poiDistrict: Json, districtPayload: unknown, calls: string[]) {
  return { nativeOnly: true, async vbkSessionFetch(request: { endpoint: string }) {
    calls.push(request.endpoint);
    return request.endpoint.includes('suggestDistrict')
      ? { status: 200, payload: districtPayload }
      : { status: 200, payload: { ResponseStatus: { Ack: 'Success' }, poiList: [{
        localName: '松苑公园', poiName: '松苑公园', poiId: 86679, district: structuredClone(poiDistrict),
      }] } };
  } } as never;
}

test('中文行政区缺省市父链时按 districtId 独立补齐后再解析', async () => {
  const calls: string[] = [];
  const detail = await suggestPoiDetail(browserFor(
    { districtId: 983, districtName: '漠河', districtType: 'City' },
    { ResponseStatus: { Ack: 'Success' }, districts: [{
      districtId: 983, districtName: '漠河', districtType: 'City', parents: hierarchy,
    }] }, calls), '松苑公园', { province: '黑龙江' });
  assert.deepEqual(detail.candidates[0] && {
    province: detail.candidates[0].province, city: detail.candidates[0].city, district: detail.candidates[0].district,
  }, { province: '黑龙江', city: '大兴安岭', district: '漠河' });
  assert.equal(calls.filter(value => value.includes('suggestDistrict')).length, 1);
});

test('完整中文父链不额外查询，也不受冲突响应影响', async () => {
  const calls: string[] = [];
  const detail = await suggestPoiDetail(browserFor(
    { districtId: 983, districtName: '漠河', districtType: 'City', parents: hierarchy },
    { ResponseStatus: { Ack: 'Success' }, districts: [{ districtId: 983, districtName: '漠河',
      districtType: 'City', parents: [{ districtId: 1, districtName: '外省', districtType: 'Province' }] }] }, calls),
  '松苑公园', { province: '黑龙江' });
  assert.equal(calls.length, 1);
  assert.equal(detail.candidates[0]?.province, '黑龙江');
  assert.equal(detail.candidates[0]?.city, '大兴安岭');
});

test('错误 districtId、残缺响应或查询失败均不猜测父链', async () => {
  for (const response of [
    { ResponseStatus: { Ack: 'Success' }, districts: [{ districtId: 984, districtName: '漠河', parents: hierarchy }] },
    { ResponseStatus: { Ack: 'Success' }, districts: [{ districtId: 983, districtName: '漠河',
      districtType: 'City', parents: [{ districtId: 396, districtName: '大兴安岭', districtType: 'City' }] }] },
    { ResponseStatus: { Ack: 'Failure' }, districts: [{ districtId: 983, districtName: '漠河',
      districtType: 'City', parents: hierarchy }] },
    { districts: [{ districtId: 983, districtName: '漠河', districtType: 'City', parents: hierarchy }] },
    new Error('read failed'),
  ]) {
    const calls: string[] = [];
    const browser = response instanceof Error ? { nativeOnly: true, async vbkSessionFetch(request: { endpoint: string }) {
      calls.push(request.endpoint); if (request.endpoint.includes('suggestDistrict')) throw response;
      return { status: 200, payload: { ResponseStatus: { Ack: 'Success' }, poiList: [{ localName: '松苑公园',
        poiId: 86679, district: { districtId: 983, districtName: '漠河', districtType: 'City' } }] } };
    } } as never : browserFor({ districtId: 983, districtName: '漠河', districtType: 'City' }, response, calls);
    const detail = await suggestPoiDetail(browser, '松苑公园', { province: '黑龙江' });
    assert.equal(detail.candidates[0]?.province, null);
    assert.equal(detail.candidates[0]?.city, '漠河');
    assert.equal(calls.filter(value => value.includes('suggestDistrict')).length, 1);
  }
});

test('空父级名称不算完整，已有部分地域证据冲突时拒绝覆盖', async () => {
  const emptyNameCalls: string[] = [];
  const repaired = await suggestPoiDetail(browserFor({ districtId: 983, districtName: '漠河', districtType: 'City',
    parents: [{ districtId: 396, districtName: '大兴安岭', districtType: 'City' },
      { districtId: 100055, districtName: '', districtType: 'Province' }] },
  { ResponseStatus: { Ack: 'Success' }, districts: [{ districtId: 983, districtName: '漠河',
    districtType: 'City', parents: hierarchy }] }, emptyNameCalls), '松苑公园', { province: '黑龙江' });
  assert.equal(emptyNameCalls.filter(value => value.includes('suggestDistrict')).length, 1);
  assert.equal(repaired.candidates[0]?.province, '黑龙江');

  const conflictCalls: string[] = [];
  const conflicted = await suggestPoiDetail(browserFor({ districtId: 983, districtName: '漠河', districtType: 'County',
    parents: [{ districtId: 100053, districtName: '湖南', districtType: 'Province' }] },
  { ResponseStatus: { Ack: 'Success' }, districts: [{ districtId: 983, districtName: '漠河',
    districtType: 'City', parents: hierarchy }] }, conflictCalls), '松苑公园', { province: '黑龙江' });
  assert.equal(conflictCalls.filter(value => value.includes('suggestDistrict')).length, 0);
  assert.equal(conflicted.candidates[0]?.province, '湖南');
  assert.equal(conflicted.candidates[0]?.city, null);
});

test('残缺层级按 districtId 去重且查询数量有硬上限', async () => {
  const calls: number[] = [];
  const poiList = Array.from({ length: 20 }, (_, index) => ({
    poiId: index + 1,
    district: { districtId: index < 2 ? 983 : 1_000 + index, districtName: index < 2 ? '漠河' : `测试区${index}`,
      districtType: 'City' },
  }));
  await localizePoiListDistricts({ nativeOnly: true, async vbkSessionFetch(request: { body: { keyword: string } }) {
    const districtId = request.body.keyword === '漠河' ? 983 : Number(request.body.keyword.replace('测试区', '')) + 1_000;
    calls.push(districtId);
    return { status: 200, payload: { ResponseStatus: { Ack: 'Success' }, districts: [{ districtId,
      districtName: request.body.keyword, districtType: 'City', parents: hierarchy }] } };
  } } as never, poiList, { province: '黑龙江' });
  assert.equal(calls.filter(id => id === 983).length, 1);
  assert.equal(calls.length, 12);
});

test('规划省份只裁剪明确外地或已闭合父链的补全任务，不裁剪 POI 候选', async () => {
  const calls: string[] = [];
  const poiList = [
    { district: { districtId: 983, districtName: '漠河', districtType: 'City' } },
    { district: { districtId: 100053, districtName: '长沙', districtType: 'City', parents: [
      { districtId: 18, districtName: '湖南', districtType: 'Province' },
    ] } },
    { district: { districtId: 100001, districtName: '东京', districtType: 'City', parents: [
      { districtId: 2, districtName: '日本', districtType: 'Country' },
    ] } },
    { district: { districtId: 100002, districtName: 'Tokyo', districtType: 'City', parents: [
      { districtId: 2, districtName: '日本', districtType: 'Country' },
    ] } },
    { district: { districtId: 2, districtName: '上海', districtType: 'City', parents: [
      { districtId: 1, districtName: '中国', districtType: 'Country' },
    ] } },
  ];
  await localizePoiListDistricts({ nativeOnly: true, async vbkSessionFetch(request: { body: { keyword: string } }) {
    calls.push(request.body.keyword);
    return { status: 200, payload: { ResponseStatus: { Ack: 'Success' }, districts: [{ districtId: 983,
      districtName: '漠河', districtType: 'City', parents: hierarchy }] } };
  } } as never, poiList, { province: '黑龙江' });
  assert.deepEqual(calls, ['漠河']);
  assert.equal(poiList.length, 5);
});

test('无规划省份时保持旧语义，不为中文残缺层级发起补全', async () => {
  const calls: string[] = [];
  const poiList = [{ district: { districtId: 983, districtName: '漠河', districtType: 'City' } }];
  await localizePoiListDistricts({ nativeOnly: true, async vbkSessionFetch(request: { body: { keyword: string } }) {
    calls.push(request.body.keyword);
    return { status: 200, payload: {} };
  } } as never, poiList);
  assert.deepEqual(calls, []);
});

test('中国 Country-only 的普通城市继续补全，省级城市直接投影省市', async () => {
  const moheCalls: string[] = [];
  await suggestPoiDetail(browserFor({ districtId: 983, districtName: '漠河', districtType: 'City', parents: [
    { districtId: 110000, districtName: '中国', districtType: 'Country' },
  ] }, { ResponseStatus: { Ack: 'Success' }, districts: [{ districtId: 983, districtName: '漠河',
    districtType: 'City', parents: hierarchy }] }, moheCalls), '松苑公园', { province: '黑龙江' });
  assert.equal(moheCalls.filter(value => value.includes('suggestDistrict')).length, 1);

  for (const city of ['北京', '上海']) {
    const calls: string[] = [];
    const detail = await suggestPoiDetail(browserFor({ districtId: city === '北京' ? 1 : 2,
      districtName: city, districtType: 'City', parents: [
        { districtId: 110000, districtName: '中国', districtType: 'Country' },
      ] }, {}, calls), '松苑公园', { province: city });
    assert.equal(calls.filter(value => value.includes('suggestDistrict')).length, 0);
    assert.equal(detail.candidates[0]?.province, city);
    assert.equal(detail.candidates[0]?.city, city);
  }
});

test('省级城市自身地域可被外省上下文拒绝，外国 Country-only 不补查', async () => {
  const beijingCalls: string[] = [];
  const beijing = await suggestPoiDetail(browserFor({ districtId: 1, districtName: '北京', districtType: 'City', parents: [
    { districtId: 110000, districtName: '中国', districtType: 'Country' },
  ] }, {}, beijingCalls), '松苑公园', { province: '黑龙江' });
  assert.equal(beijing.best, null);
  assert.equal(beijing.candidates[0]?.province, '北京');
  assert.equal(beijingCalls.filter(value => value.includes('suggestDistrict')).length, 0);

  const foreignCalls: string[] = [];
  await suggestPoiDetail(browserFor({ districtId: 3, districtName: '东京', districtType: 'City', parents: [
    { districtId: 100069, districtName: '日本', districtType: 'Country' },
  ] }, {}, foreignCalls), '松苑公园', { province: '黑龙江' });
  assert.equal(foreignCalls.filter(value => value.includes('suggestDistrict')).length, 0);
});

test('省级城市名带明确外国 Country 时不推导中国省份', async () => {
  const calls: string[] = [];
  const detail = await suggestPoiDetail(browserFor({ districtId: 4, districtName: '上海', districtType: 'City', parents: [
    { districtId: 100047, districtName: '美国', districtType: 'Country' },
  ] }, {}, calls), '松苑公园', { province: '上海' });
  assert.equal(calls.filter(value => value.includes('suggestDistrict')).length, 0);
  assert.equal(detail.candidates[0]?.province, null);
  assert.equal(detail.candidates[0]?.city, '上海');
  assert.equal(detail.best, null);
});
