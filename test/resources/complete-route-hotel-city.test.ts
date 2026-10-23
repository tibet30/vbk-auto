import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProductSnapshot } from '../../src/main/infrastructure/database/parts/product-draft.js';
import { projectCompleteItinerary } from '../../src/main/planning/complete-itinerary-projection.js';
import { normalisePlatformHotelProduct, platformHotelStayGroups } from '../../src/shared/platform-hotel-rules.js';

const raw = 'Day1 出发地-哈尔滨市\\nDay2 漠河接站-龙江第一湾-中国最北点-乌苏里浅滩-北红村篝火晚会\\nDay3 泼水成冰-马拉爬犁-鄂温克使鹿部落-圣诞村-滑雪2小时-北极村\\nDay4 北极星广场-松苑公园-五·六火灾纪念馆-漠河舞厅';
function fixture() {
  const detail = buildProductSnapshot({ destination: '哈尔滨', days: 4, productForm: 'privateTour', userIdea: raw });
  detail.product.basicInfo!.province = '黑龙江';
  detail.product.itinerary = projectCompleteItinerary(detail)!.modules[0]!.value as never;
  return detail.product as Record<string, any>;
}
function bindDay(product: Record<string, any>, day: number, district = '漠河', city = '大兴安岭') {
  product.itinerary[day - 1].spots.filter((spot: any) => spot.kind === 'attraction').forEach((spot: any, index: number) => {
    Object.assign(spot, { poiId: day * 100 + index + 1, poiName: spot.name, province: '黑龙江', city, district });
  });
}

test('完整原路线不能把接团城市虚称为每晚用户指定住宿城市', () => {
  const product = fixture();
  assert.doesNotMatch(JSON.stringify(product.itinerary.slice(1, 3)), /按用户要求住哈尔滨|哈尔滨（待匹配）/u);
  assert.match(product.itinerary[1].description, /北红村篝火晚会/u);
  assert.match(product.itinerary[2].description, /北极村/u);
  const normalised = normalisePlatformHotelProduct(product);
  assert.deepEqual(normalised.itinerary.map((day: any) => day.hotelCity), ['哈尔滨', undefined, undefined, undefined]);
  assert.throws(() => platformHotelStayGroups(normalised), /缺少住宿城市/u);
  assert.deepEqual(normalisePlatformHotelProduct(normalised), normalised, '再次保存不能恢复接团城市默认值');
});

test('原路线当晚落点和已核验 POI 地域确定跨城住宿，三晚和规则保持不变', () => {
  const product = fixture();
  bindDay(product, 2); bindDay(product, 3); bindDay(product, 4);
  const normalised = normalisePlatformHotelProduct(product);
  assert.deepEqual(normalised.itinerary.map((day: any) => day.hotelCity), ['哈尔滨', '漠河', '漠河', undefined]);
  assert.deepEqual(platformHotelStayGroups(normalised).map(({ cityName, nights }) => ({ cityName, nights })),
    [{ cityName: '哈尔滨', nights: 1 }, { cityName: '漠河', nights: 2 }]);
  assert.deepEqual(normalised.operations.hotelRules, { autoMatch: true, grades: [3, 4, 5] });
  assert.equal(normalised.basicInfo.meetingCity, '哈尔滨');
  assert.equal(normalised.basicInfo.destinationCity, '哈尔滨');
  assert.equal(normalised.basicInfo.userIdea, raw);
  assert.doesNotMatch(JSON.stringify(normalised.itinerary), /住宿行政城市待资源核验/u);
  assert.deepEqual(normalisePlatformHotelProduct(normalised), normalised);
});

test('D、第N天与中文日期使用相同的跨城住宿证据', () => {
  for (const source of [raw.replaceAll('Day', 'D'), raw.replace(/Day(\d)/gu, '第$1天'),
    raw.replace(/Day(\d)/gu, (_, digit) => `第${'一二三四'[Number(digit) - 1]}天`)]) {
    const product = fixture(); product.basicInfo.userIdea = source; bindDay(product, 2); bindDay(product, 3); bindDay(product, 4);
    assert.deepEqual(normalisePlatformHotelProduct(product).itinerary.map((day: any) => day.hotelCity),
      ['哈尔滨', '漠河', '漠河', undefined]);
  }
});

test('程序推导的 POI 城市不得覆盖运营已保存的住宿城市', () => {
  const product = fixture(); bindDay(product, 2); bindDay(product, 3);
  product.itinerary[1].hotelCity = '哈尔滨';
  product.itinerary[2].hotelCity = '齐齐哈尔';
  const normalised = normalisePlatformHotelProduct(product);
  assert.equal(normalised.itinerary[1].hotelCity, '哈尔滨');
  assert.equal(normalised.itinerary[2].hotelCity, '齐齐哈尔');
});

test('住宿城市不从缺地域、非原路线、外省或互相冲突的 POI 推定', () => {
  for (const mutate of [
    (spots: any[]) => delete spots[0].province,
    (spots: any[]) => { spots[0].city = '齐齐哈尔'; },
    (spots: any[]) => { spots[0].province = '吉林'; },
    (spots: any[]) => { spots.forEach(spot => { spot.name = '伪造的路线外景点'; }); },
  ]) {
    const product = fixture(); bindDay(product, 3); mutate(product.itinerary[2].spots.filter((spot: any) => spot.kind === 'attraction'));
    assert.equal(normalisePlatformHotelProduct(product).itinerary[2].hotelCity, undefined);
  }
});

test('省内旧错绑不能仅凭自身城市为住宿推导作证', () => {
  const product = fixture(); bindDay(product, 2, '龙沙', '齐齐哈尔');
  assert.equal(normalisePlatformHotelProduct(product).itinerary[1].hotelCity, undefined);
});

test('明确重放原始路线必须重建旧投影，不能复用结构合法的错误住宿默认值', () => {
  const detail = buildProductSnapshot({ destination: '哈尔滨', days: 4, productForm: 'privateTour', userIdea: raw });
  detail.product = fixture();
  for (const day of detail.product.itinerary!.slice(0, 3)) day.hotelCity = '哈尔滨';
  detail.messages.push({ id: 'replay', role: 'user', createdAt: new Date().toISOString(),
    content: '请从头重新规划当前产品，按原始完整逐日路线重新生成并继续本地资源核验。' });
  const rebuilt = projectCompleteItinerary(detail);
  assert.ok(rebuilt);
  assert.equal(normalisePlatformHotelProduct({ ...detail.product, itinerary: rebuilt.modules[0]!.value })
    .itinerary[1].hotelCity, undefined);
});
