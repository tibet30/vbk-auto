import assert from 'node:assert/strict';
import test from 'node:test';
import { ensurePlatformHotelRulesApi, hotelRuleProvince, verifyPlatformHotelDraftRulesReadback, verifyPlatformHotelRulesReadback } from '../../src/main/automation/ctrip/hotel-rule-api.js';
import { normalisePlatformHotelProduct } from '../../src/shared/platform-hotel-rules.js';
import { routeFingerprint } from '../../src/main/planning/daily-route-structure.js';
import { mergedDailyRouteSources } from '../../src/main/agent/daily-route-source.js';
import { constraintUserIdea } from '../../src/shared/product-idea-optimization.js';

const jilin = { cityId: 159, cityName: '吉林市', provinceName: '吉林', countryName: '中国' };
const mudanjiang = { cityId: 150, cityName: '牡丹江', provinceName: '黑龙江', countryName: '中国' };
const harbin = { cityId: 5, cityName: '哈尔滨', provinceName: '黑龙江', countryName: '中国' };

type City = { cityId: number; cityName: string; provinceName: string; countryName: string };

function defaultProduct() {
  return { sales: { productForm: 'privateTour' },
    basicInfo: { meetingCity: '吉林', destinationCity: '吉林', province: '吉林', nights: 2,
      userIdea: '第一天吉林-朝鲜古村落-牡丹江\n第二天牡丹江-镜泊湖-哈尔滨\n第三天哈尔滨-送机' },
    itinerary: [
      { day: 1, hotelCity: '牡丹江', hotel: '平台酒店', spots: [{ name: '朝鲜古村落', poiName: '延吉春兴朝鲜族古村落民俗文化园', poiId: 134445140, province: '吉林', city: '延边', district: '延吉' }] },
      { day: 2, hotelCity: '哈尔滨', hotel: '平台酒店', spots: [] },
      { day: 3, hotel: '无当日住宿安排', spots: [] },
    ] };
}

function fixture(options: { product?: any; departureCity?: City; nights?: number; catalog?: City[] } = {}) {
  const input = normalisePlatformHotelProduct(options.product ?? defaultProduct());
  const departureCity = options.departureCity ?? jilin;
  const nights = options.nights ?? 2;
  const catalog = options.catalog ?? [mudanjiang, harbin];
  const base = { segmentNumber: 1, stayNights: nights, minStayNights: nights, maxStayNights: nights,
    departureCity, destinationCity: departureCity, deleteable: false };
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
      extra = { cities: state.badCity ?? catalog.filter(city => city.cityName === request.body.keyword) };
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

/**
 * 真实事故：路线写「…祁连黑河源 | 宿肃南」，三晚住宿地全在青海只有肃南属甘肃。
 * `| 宿X` 若不按住宿注记解析，肃南就不算显式指定，只能继承接团省份「青海」，
 * 平台唯一的「甘肃/肃南」被筛成 0 个候选，录入在资源段阶段暂停。
 */
const sunan: City = { cityId: 21323, cityName: '肃南', provinceName: '甘肃', countryName: '中国' };
const qinghaiCatalog: City[] = [
  { cityId: 10, cityName: '西宁', provinceName: '青海', countryName: '中国' },
  { cityId: 11, cityName: '门源', provinceName: '青海', countryName: '中国' },
  { cityId: 12, cityName: '祁连', provinceName: '青海', countryName: '中国' },
  sunan,
];

function sunanProduct() {
  return { sales: { productForm: 'freeTravel' },
    basicInfo: { meetingCity: '西宁', destinationCity: '西宁', province: '青海', nights: 3,
      userIdea: 'D1：西宁 — 仙米国家森林公园 — 达坂山观景台 | 宿门源\nD2：门源 — 岗什卡雪峰 | 宿祁连\n'
        + 'D3：祁连 — 祁连 9 号公路 — 祁连黑河源 | 宿肃南\nD4：祁连 — 巴尔斯雪山 - 七彩丹霞 | 张掖结束行程' },
    itinerary: [
      { day: 1, hotelCity: '门源', hotel: '平台酒店', spots: [{ name: '仙米国家森林公园', poiName: '仙米国家森林公园', poiId: 18733301, province: '青海', city: '海北', district: '门源' }] },
      { day: 2, hotelCity: '祁连', hotel: '平台酒店', spots: [{ name: '岗什卡雪峰', poiName: '祁连山·岗什卡雪峰景区', poiId: 22866370, province: '青海', city: '海北', district: '祁连' }] },
      { day: 3, hotelCity: '肃南', hotel: '平台酒店', spots: [{ name: '祁连 9 号公路', poiName: '祁连9号公路自驾打卡点', poiId: 1, province: '青海', city: '海北', district: '祁连' }] },
      { day: 4, hotel: '无当日住宿安排', spots: [] },
    ] };
}

test('「| 宿X」注记的跨省住宿地按注记城市解析，不按接团省份筛掉', async () => {
  const { input, state, page } = fixture({ product: sunanProduct(), departureCity: qinghaiCatalog[0]!, nights: 3, catalog: qinghaiCatalog });
  const result = await ensurePlatformHotelRulesApi(page, input, '81407112', { draftOnly: true });
  assert.equal(result.verified, true);
  assert.deepEqual(state.segments.slice(1, -1).map(segment => [segment.segmentBase.destinationCity.cityName,
    segment.segmentBase.destinationCity.provinceName, segment.segmentBase.stayNights]),
  [['门源', '青海', 1], ['祁连', '青海', 1], ['肃南', '甘肃', 1]]);
  assert.equal((await verifyPlatformHotelDraftRulesReadback(page, input, '81407112')).verified, true);
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

test('「夜宿X」等行内注记同样算显式住宿地，跨省照常解析', async () => {
  const product = sunanProduct();
  product.basicInfo.userIdea = product.basicInfo.userIdea.replace('| 宿肃南', ' 夜宿肃南');
  const { input, state, page } = fixture({ product, departureCity: qinghaiCatalog[0]!, nights: 3, catalog: qinghaiCatalog });
  await ensurePlatformHotelRulesApi(page, input, '81407112', { draftOnly: true });
  assert.deepEqual(state.segments.slice(1, -1).map(segment => [segment.segmentBase.destinationCity.cityName,
    segment.segmentBase.destinationCity.provinceName]),
  [['门源', '青海'], ['祁连', '青海'], ['肃南', '甘肃']]);
});

test('跨省住宿地只被省份筛掉时，报错给出可照做的写作提示', async () => {
  const { input, page } = fixture(); input.basicInfo.userIdea = '第一天吉林游览\n第二天吉林自由活动\n第三天吉林返程';
  await assert.rejects(ensurePlatformHotelRulesApi(page, input, '80319520', { draftOnly: true }),
    /请在原路线当天写明「宿牡丹江」/);
});

test('AI 结构读出的住宿地支撑跨省解析，不依赖正则认出原文写法', async () => {
  const product = sunanProduct();
  product.basicInfo.userIdea = product.basicInfo.userIdea.replace('| 宿肃南', ' 当晚在肃南过夜');
  product.diagnostics = { dailyRouteStructure: {
    version: 2,
    fingerprint: routeFingerprint(mergedDailyRouteSources(constraintUserIdea(product.basicInfo))),
    days: [
      { day: 1, nodes: [{ name: '西宁', kind: 'place' }, { name: '仙米国家森林公园', kind: 'attraction' }], overnight: { name: '门源' } },
      { day: 2, nodes: [{ name: '门源', kind: 'place' }, { name: '岗什卡雪峰', kind: 'attraction' }], overnight: { name: '祁连' } },
      { day: 3, nodes: [{ name: '祁连', kind: 'place' }, { name: '祁连黑河源', kind: 'attraction' }], overnight: { name: '肃南' } },
      { day: 4, nodes: [{ name: '巴尔斯雪山', kind: 'attraction' }] },
    ],
  } };
  const { input, state, page } = fixture({ product, departureCity: qinghaiCatalog[0]!, nights: 3, catalog: qinghaiCatalog });
  await ensurePlatformHotelRulesApi(page, input, '81407112', { draftOnly: true });
  assert.deepEqual(state.segments.slice(1, -1).map(segment => [segment.segmentBase.destinationCity.cityName,
    segment.segmentBase.destinationCity.provinceName]),
  [['门源', '青海'], ['祁连', '青海'], ['肃南', '甘肃']]);
});
