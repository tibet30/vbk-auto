import assert from 'node:assert/strict';
import test from 'node:test';
import { ensurePlatformHotelRulesApi, hotelRuleProvince, verifyPlatformHotelDraftRulesReadback, verifyPlatformHotelRulesReadback } from '../../src/main/automation/ctrip/hotel-rule-api.js';
import { normalisePlatformHotelProduct } from '../../src/shared/platform-hotel-rules.js';

const jilin = { cityId: 159, cityName: '吉林市', provinceName: '吉林', countryName: '中国' };
const mudanjiang = { cityId: 150, cityName: '牡丹江', provinceName: '黑龙江', countryName: '中国' };
const harbin = { cityId: 5, cityName: '哈尔滨', provinceName: '黑龙江', countryName: '中国' };

function fixture() {
  const input = normalisePlatformHotelProduct({ sales: { productForm: 'privateTour' },
    basicInfo: { meetingCity: '吉林', destinationCity: '吉林', province: '吉林', nights: 2,
      userIdea: '第一天吉林-朝鲜古村落-牡丹江\n第二天牡丹江-镜泊湖-哈尔滨\n第三天哈尔滨-送机' },
    itinerary: [
      { day: 1, hotelCity: '牡丹江', hotel: '平台酒店', spots: [{ name: '朝鲜古村落', poiName: '延吉春兴朝鲜族古村落民俗文化园', poiId: 134445140, province: '吉林', city: '延边', district: '延吉' }] },
      { day: 2, hotelCity: '哈尔滨', hotel: '平台酒店', spots: [] },
      { day: 3, hotel: '无当日住宿安排', spots: [] },
    ] });
  const base = { segmentNumber: 1, stayNights: 2, minStayNights: 2, maxStayNights: 2,
    departureCity: jilin, destinationCity: jilin, deleteable: false };
  const state = { writes: 0, badCity: undefined as any, queries: [] as string[], segments: [
    { segmentId: 'full', productId: 'existing-80319520', segmentBase: base },
    { segmentId: 'end', productId: 'existing-80319520', segmentBase: { ...base, segmentNumber: 2,
      stayNights: 0, minStayNights: 0, maxStayNights: 0, deleteable: true } },
  ] as any[] };
  const page = { nativeOnly: true, vbkSessionFetch: async (request: any) => {
    const action = new URL(request.endpoint).pathname.split('/').at(-1);
    assert.ok(['getSegments', 'saveSegment', 'suggestDepartureCity'].includes(action!), `unexpected external operation ${action}`);
    let extra = {};
    if (action === 'suggestDepartureCity') {
      state.queries.push(request.body.keyword);
      extra = { cities: state.badCity ?? [mudanjiang, harbin].filter(city => city.cityName === request.body.keyword) };
    }
    if (action === 'saveSegment') {
      state.writes++;
      const segment = structuredClone(request.body.segment);
      assert.equal(segment.productId, 'existing-80319520');
      if (Number(segment.segmentId) === 0) {
        segment.segmentId = `stay-${state.writes}`;
        state.segments.splice(-1, 0, segment);
        state.segments.forEach((value, index) => { value.segmentBase.segmentNumber = index + 1; });
      } else state.segments = state.segments.map(value => value.segmentId === segment.segmentId ? segment : value);
    }
    if (action === 'getSegments') extra = { draftProductSegments: { segments: structuredClone(state.segments) },
      productSegments: { segments: structuredClone(state.segments) } };
    return { status: 200, payload: { ResponseStatus: { Ack: 'Success' }, ...extra } };
  } };
  return { input, state, page };
}

test('explicit cross-province overnight cities save despite all bound POIs remaining in the arrival province', async () => {
  const { input, state, page } = fixture();
  const result = await ensurePlatformHotelRulesApi(page, input, '80319520', { draftOnly: true });
  assert.equal(result.verified, true);
  assert.deepEqual(state.segments.slice(1, -1).map(segment => [segment.segmentBase.destinationCity.cityName,
    segment.segmentBase.destinationCity.provinceName, segment.segmentBase.stayNights]), [['牡丹江', '黑龙江', 1], ['哈尔滨', '黑龙江', 1]]);
  assert.ok(state.segments.slice(1, -1).every(segment =>
    JSON.stringify(segment.hotel.systemHotel.hotelStar) === '[3,4,5]' && !segment.hotel.segmentRooms.length));
  assert.equal((await verifyPlatformHotelDraftRulesReadback(page, input, '80319520')).verified, true);
  assert.equal((await verifyPlatformHotelRulesReadback(page, input, '80319520')).verified, true);
  const writes = state.writes;
  await ensurePlatformHotelRulesApi(page, input, '80319520', { draftOnly: true });
  assert.equal(state.writes, writes);
  assert.equal(input.basicInfo.meetingCity, '吉林');
});

test('cross-province permission does not accept overseas, ambiguous, missing-province or wrong-name city responses', async () => {
  for (const candidates of [[{ ...mudanjiang, countryName: '日本' }], [mudanjiang, { ...mudanjiang, cityId: 999 }],
    [{ ...mudanjiang, provinceName: '' }], [{ ...mudanjiang, cityName: '其他城市' }]]) {
    const { input, state, page } = fixture(); state.badCity = candidates;
    await assert.rejects(ensurePlatformHotelRulesApi(page, input, '80319520', { draftOnly: true }));
    assert.equal(state.writes, 0);
  }
});

test('a hotel city without original route support cannot use an arbitrary outside-province candidate', async () => {
  const { input, state, page } = fixture(); input.basicInfo.userIdea = '第一天吉林游览\n第二天吉林自由活动\n第三天吉林返程';
  await assert.rejects(ensurePlatformHotelRulesApi(page, input, '80319520', { draftOnly: true }), /吉林\/牡丹江/);
});

test('readback rechecks current administrative identity and never repairs wrong saved province or city ID', async () => {
  const { input, state, page } = fixture();
  await ensurePlatformHotelRulesApi(page, input, '80319520', { draftOnly: true });
  const original = structuredClone(state.segments);
  const writes = state.writes;
  for (const corrupt of [{ provinceName: '吉林' }, { cityId: 999 }, { countryName: '日本' }]) {
    state.segments = structuredClone(original);
    Object.assign(state.segments[1].segmentBase.destinationCity, corrupt);
    await assert.rejects(verifyPlatformHotelDraftRulesReadback(page, input, '80319520'), /回读不一致/);
    await assert.rejects(verifyPlatformHotelRulesReadback(page, input, '80319520'), /回读不一致/);
    assert.equal(state.writes, writes);
  }
});

test('住宿城市当天无景点时用当天和次日景点推断省份', () => {
  const spot = (name: string, province: string, city: string) => ({ name, poiName: name, poiId: 1, province, city });
  const product = { basicInfo: { meetingCity: '兰州', province: '甘肃', nights: 3 }, itinerary: [
    { day: 1, hotelCity: '兰州', spots: [spot('中山桥', '甘肃', '兰州')] },
    { day: 2, hotelCity: '西宁', spots: [spot('互助土族故土园', '青海', '海东')] },
    { day: 3, hotelCity: '海北', spots: [spot('青海湖', '青海', '海北')] },
    { day: 4, spots: [spot('鸣沙山', '甘肃', '敦煌')] },
  ] };
  assert.equal(hotelRuleProvince(product, '西宁'), undefined);
  assert.equal(hotelRuleProvince(product, '西宁', [2]), '青海');
  assert.equal(hotelRuleProvince(product, '西宁', [3]), undefined, '次日跨省时不推断');
});
