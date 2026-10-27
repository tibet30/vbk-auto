import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProductSnapshot } from '../../src/main/infrastructure/database/parts/product-draft.js';
import { normaliseNumberedRouteAdministrativeNodes } from '../../src/main/planning/numbered-route-administrative.js';
import { buildPoiContextForItineraryDay } from '../../src/main/planning/poi-context.js';
import { isPlanningPoiCandidateInContext, resolvePlanningPoiAutoSelection } from '../../src/main/planning/poi-auto-selection.js';
import { screenManualPoiCandidates, verifyManualPoiSelection } from '../../src/main/operations/manual-review-poi-selection.js';
import { routeLocationBlockers, verifiedRouteOvernightCity } from '../../src/shared/route-location-evidence.js';
import { normalisePlatformHotelProduct, platformHotelStayGroups } from '../../src/shared/platform-hotel-rules.js';
import { splitProduct, composeProduct } from '../../src/shared/product-storage-projection.js';
import { withRouteRequirements } from '../../src/shared/route-requirement-context.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { VbkDatabase } from '../../src/main/infrastructure/database/database.js';
import { ProductMutationService } from '../../src/main/application/product-mutation-service.js';
import { extractLockedConstraints } from '../../src/main/agent/prompt-helpers.js';

type Json = Record<string, any>;
const provinces: Record<string, string> = { 吉林: '吉林', 延吉: '吉林', 牡丹江: '黑龙江', 哈尔滨: '黑龙江' };
const poi = (name = '中央大街', city = '哈尔滨', province = '黑龙江') => ({
  index: 0, poiId: 77071, poiName: name, selectable: true, province, city, district: city, textFields: [],
});
const detail = (candidates = [poi()]) => ({ httpStatus: 200, businessStatus: 'Success',
  poiListCount: candidates.length, best: { poiId: candidates[0].poiId, poiName: candidates[0].poiName }, candidates });

async function fixture() {
  const p = buildProductSnapshot({ destination: '吉林', days: 3, productForm: 'privateTour',
    userIdea: '第一天吉林-雾凇长廊-延吉\n第二天延吉-朝鲜古村落-牡丹江-镜泊湖-哈尔滨-中央大街-哈尔滨\n第三天哈尔滨-索菲亚教堂-送机' });
  Object.assign(p.product.basicInfo!, { province: '吉林' });
  p.product.itinerary = [
    { day: 1, title: '吉林到延吉', spots: [{ name: '雾凇长廊', kind: 'attraction' }] },
    { day: 2, title: '跨省游览', spots: ['朝鲜古村落', '镜泊湖', '中央大街'].map(name => ({ name, kind: 'attraction' })) },
    { day: 3, title: '哈尔滨返程', spots: [{ name: '索菲亚教堂', kind: 'attraction' }] },
  ] as any;
  const queried: string[] = [];
  const result = await normaliseNumberedRouteAdministrativeNodes(p, { nativeOnly: true,
    vbkSessionFetch: async (request: any) => {
      const name = request.body.keyword; queried.push(name);
      return { status: 200, payload: { ResponseStatus: { Ack: 'Success' }, districts: provinces[name] ? [{
        districtId: Object.keys(provinces).indexOf(name) + 1, districtName: `${name}市`, districtType: 'City',
        parents: [{ districtName: provinces[name], districtType: 'Province' }],
      }] : [] } };
    } } as any);
  assert.ok(result);
  p.product.itinerary = result.itinerary as any;
  p.product.diagnostics = { routeLocations: result.locations };
  return { product: p.product as Json, queried };
}

test('native route evidence supports cross-province automatic selection without changing the city anchor', async () => {
  const { product, queried } = await fixture();
  const day = product.itinerary[1];
  const context = buildPoiContextForItineraryDay(product, '吉林', day, '中央大街');
  assert.deepEqual(context, { province: '黑龙江', destinationCity: '哈尔滨', itineraryDay: 2, spotName: '中央大街' });
  assert.equal(queried.filter(name => name === '哈尔滨').length, 1);
  const result = await resolvePlanningPoiAutoSelection({ localProductId: 'isolated', keyword: '中央大街',
    context, product, detail: detail(), checkAvailability: async () => ({ status: 'available' }) });
  assert.equal(result.status, 'available');
  assert.equal(result.match?.poiId, 77071);
  assert.equal(product.basicInfo.meetingCity, '吉林');
  assert.equal(product.basicInfo.destinationCity, '吉林');
});

test('a stop can only use adjacent route anchors, not every province or city mentioned on the day', async () => {
  const { product } = await fixture();
  const context = buildPoiContextForItineraryDay(product, '吉林', product.itinerary[1], '中央大街');
  for (const candidate of [poi('中央大街', '延吉', '吉林'), poi('中央大街', '牡丹江'),
    poi('中央大街', '长春', '吉林'), { ...poi(), province: undefined }, { ...poi(), city: undefined }]) {
    assert.equal(isPlanningPoiCandidateInContext(candidate, context, product, '中央大街', [candidate]), false);
  }
  const mirrorContext = buildPoiContextForItineraryDay(product, '吉林', product.itinerary[1], '镜泊湖');
  const mirror = poi('镜泊湖', '牡丹江');
  assert.equal(isPlanningPoiCandidateInContext(mirror, mirrorContext, product, '镜泊湖', [mirror]), true);
  assert.equal(isPlanningPoiCandidateInContext(poi('镜泊湖', '延吉', '吉林'), mirrorContext, product, '镜泊湖'), false);
});

test('manual search and save use the same scope and rebuild the selected location from the provider', async () => {
  const { product } = await fixture();
  const result = detail([poi(), { ...poi('中央大街', '长春', '吉林'), poiId: 99 }]);
  const screened = screenManualPoiCandidates(product, 1, 2, result);
  assert.deepEqual(screened.candidates.map(item => item.selectable), [true, false]);
  const input = { field: 'itinerarySpotPoi' as const, dayIndex: 1, spotIndex: 2, poiId: 77071,
    poiName: '中央大街', province: '伪造', city: '伪造', district: '伪造' };
  assert.equal(verifyManualPoiSelection(product, input, result).province, '黑龙江');
  assert.throws(() => verifyManualPoiSelection(product, { ...input, poiId: 99 }, result), /地域约束不匹配/);
});

test('current readiness rejects wrong saved locations even when the POI identity and old task success remain', async () => {
  const { product } = await fixture();
  Object.assign(product.itinerary[1].spots[2], poi());
  assert.deepEqual(routeLocationBlockers(product), []);
  // 原路线点名哈尔滨，但把绑定城市改成同日未点名的长春 → 必须阻塞。
  product.itinerary[1].spots[2].province = '吉林';
  product.itinerary[1].spots[2].city = '长春';
  assert.equal(routeLocationBlockers(product).length, 1);
  // 回到原路线明确写出的哈尔滨：即使旧产品没有 native routeLocations，也不阻塞。
  product.itinerary[1].spots[2].city = '哈尔滨';
  delete product.diagnostics.routeLocations;
  assert.deepEqual(routeLocationBlockers(product), []);
  // 缺少城市字段时无法复核，仍阻塞。
  product.itinerary[1].spots[2].province = '黑龙江';
  delete product.itinerary[1].spots[2].city;
  assert.equal(routeLocationBlockers(product).length, 1);
});

test('generated text, old bindings, another day and stale source cannot manufacture cross-province permission', async () => {
  const withoutHarbinRoute = (p: Json) => {
    p.basicInfo.userIdea = p.basicInfo.userIdea.replaceAll('哈尔滨-中央大街-哈尔滨', '吉林-中央大街-吉林');
  };
  const mutations = [
    (p: Json) => { withoutHarbinRoute(p); delete p.diagnostics.routeLocations; },
    (p: Json) => { p.itinerary[1].spots.reverse(); },
    (p: Json) => { withoutHarbinRoute(p); p.itinerary[1].description = '改为哈尔滨中央大街'; delete p.diagnostics.routeLocations; },
    (p: Json) => { withoutHarbinRoute(p); p.diagnostics.routeLocations.forEach((node: Json) => { node.day = 1; }); },
    (p: Json) => { withoutHarbinRoute(p); delete p.diagnostics.routeLocations; p.itinerary[1].hotelCity = '哈尔滨'; },
  ];
  for (const mutate of mutations) {
    const { product } = await fixture(); mutate(product);
    const context = buildPoiContextForItineraryDay(product, '吉林', product.itinerary[1], '中央大街');
    assert.equal(isPlanningPoiCandidateInContext(poi(), context, product, '中央大街', [poi()]), false);
  }
});

test('旧产品没有 native routeLocations 时，原路线明确点名的城市仍可作跨省证据', async () => {
  const { product } = await fixture();
  delete product.diagnostics.routeLocations;
  const context = buildPoiContextForItineraryDay(product, '吉林', product.itinerary[1], '中央大街');
  assert.equal(isPlanningPoiCandidateInContext(poi(), context, product, '中央大街', [poi()]), true);
  // 同日途经的牡丹江不能替中央大街作证。
  assert.equal(isPlanningPoiCandidateInContext(poi('中央大街', '牡丹江'),
    context, product, '中央大街', [poi(), poi('中央大街', '牡丹江')]), false);
});

test('cross-province matching still rejects suspended and ambiguous low-confidence choices', async () => {
  const { product } = await fixture();
  const context = buildPoiContextForItineraryDay(product, '吉林', product.itinerary[1], '中央大街');
  const base = { localProductId: 'isolated', keyword: '中央大街', context, product, detail: detail() };
  assert.equal((await resolvePlanningPoiAutoSelection({ ...base,
    checkAvailability: async () => ({ status: 'suspended' }) })).status, 'suspended');
  const uncertain = { ...detail(), best: null, candidates: [poi('同名候选')] };
  assert.equal((await resolvePlanningPoiAutoSelection({ ...base, detail: uncertain,
    disambiguate: async ({ candidates }) => ({ pickedText: candidates[0].text, confidence: 0.8 }),
    checkAvailability: async () => ({ status: 'available' }) })).reason, 'ambiguous');
});

test('same-name POIs at both sides of a provincial boundary require a current explicit selection', async () => {
  const { product } = await fixture();
  const context = buildPoiContextForItineraryDay(product, '吉林', product.itinerary[1], '朝鲜古村落');
  const candidates = [poi('朝鲜古村落', '延吉', '吉林'), { ...poi('朝鲜古村落', '牡丹江'), poiId: 99 }];
  const base = { localProductId: 'isolated', keyword: '朝鲜古村落', context, product, detail: detail(candidates),
    checkAvailability: async () => ({ status: 'available' as const }) };
  assert.equal((await resolvePlanningPoiAutoSelection(base)).reason, 'ambiguous');
  assert.equal((await resolvePlanningPoiAutoSelection({ ...base, confirmedPoiId: 99 })).match?.poiId, 99);
});

test('overnight city follows the verified original endpoint, never a daytime POI or arrival-city default', async () => {
  const { product } = await fixture();
  assert.equal(verifiedRouteOvernightCity(product, product.itinerary[0]), '延吉');
  assert.equal(verifiedRouteOvernightCity(product, product.itinerary[1]), '哈尔滨');
  const normalized = normalisePlatformHotelProduct(product);
  assert.deepEqual(normalized.itinerary.slice(0, 2).map((day: Json) => day.hotelCity), ['延吉', '哈尔滨']);
  normalized.itinerary[1].hotelCity = '吉林';
  assert.throws(() => platformHotelStayGroups(normalized), /已核验原路线落点/);
  assert.equal(normalisePlatformHotelProduct(normalized).itinerary[1].hotelCity, '哈尔滨');
  product.basicInfo.userIdea = product.basicInfo.userIdea.replace('中央大街-哈尔滨', '中央大街-雪乡');
  assert.equal(verifiedRouteOvernightCity(product, product.itinerary[1]), undefined);
});

test('native route receipts survive the resource-evidence storage projection', async () => {
  const { product } = await fixture();
  const split = splitProduct(product);
  assert.ok(split.evidence.fields.some(field => field.path.join('.') === 'diagnostics.routeLocations'));
  const restored = composeProduct(split.plan, split.evidence, split.diagnostics) as Json;
  assert.equal(buildPoiContextForItineraryDay(restored, '吉林', restored.itinerary[1], '中央大街').province, '黑龙江');
});

test('new operator route requirements invalidate old receipts, control messages do not', async () => {
  const { product } = await fixture();
  const same = withRouteRequirements(product, [{ role: 'user', content: '确认方案，继续处理' }]);
  assert.equal(buildPoiContextForItineraryDay(same, '吉林', same.itinerary[1], '中央大街').province, '黑龙江');
  for (const content of ['第二天改为延吉-中央大街-延吉', '将行程城市改为长春']) {
    const changed = withRouteRequirements(product, [{ role: 'user', content }]);
    const context = buildPoiContextForItineraryDay(changed, '吉林', changed.itinerary[1], '中央大街');
    assert.equal(isPlanningPoiCandidateInContext(poi(), context, changed, '中央大街', [poi()]), false);
  }
});

test('the production save service and independent database read preserve cross-province scope and invalidate changed intent', async () => {
  const { product } = await fixture();
  const directory = mkdtempSync(path.join(tmpdir(), 'vbk-cross-province-'));
  const db = new VbkDatabase(directory);
  let reader: VbkDatabase | undefined;
  try {
    const created = db.createProduct({ destination: '吉林', days: 3, productForm: 'privateTour', userIdea: product.basicInfo.userIdea });
    const service = new ProductMutationService(db);
    service.commands.mergeChanges(created.id, created, product, 'resource');
    const current = db.getProduct(created.id)!;
    const input = verifyManualPoiSelection(current.product, { field: 'itinerarySpotPoi', dayIndex: 1,
      spotIndex: 2, poiName: '中央大街', poiId: 77071 }, detail());
    service.commands.manualField({ localProductId: created.id, source: 'user', expectedVersion: current.productJsonVersion! }, input);
    reader = new VbkDatabase(directory);
    let saved = reader.getProduct(created.id)!;
    assert.deepEqual(routeLocationBlockers(saved.product), []);
    assert.equal((saved.product.itinerary as Json[])[1].spots[2].province, '黑龙江');
    assert.equal(saved.product.basicInfo!.meetingCity, '吉林');
    db.addMessage(created.id, 'user', '第二天改为延吉-中央大街-延吉');
    saved = reader.getProduct(created.id)!;
    assert.equal(routeLocationBlockers(saved.product).length, 1);
    const fresh = buildPoiContextForItineraryDay(saved.product, '吉林', (saved.product.itinerary as Json[])[1], '中央大街');
    assert.equal(isPlanningPoiCandidateInContext(poi(), fresh, saved.product, '中央大街'), false);
  } finally {
    reader?.close(); db.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test('flight suggestions and transfer times are not split into fabricated locked attractions', () => {
  const p = buildProductSnapshot({ destination: '吉林', days: 1, productForm: 'privateTour',
    userIdea: '第一天哈尔滨-中央大街-哈尔滨14:00送站/15:00抵达机场送机,建议17:00以后航班' });
  const names = extractLockedConstraints(p).itineraryOrder[0].spots;
  assert.ok(names.includes('哈尔滨14:00送站'));
  assert.ok(!names.includes('哈尔滨14:00'));
  assert.ok(!names.includes('后航班'));
});
