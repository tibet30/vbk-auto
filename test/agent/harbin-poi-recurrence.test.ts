import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { VbkDatabase } from '../../src/main/infrastructure/database/database.js';
import { ProductMutationService } from '../../src/main/application/product-mutation-service.js';
import { createAgentBusinessTools } from '../../src/main/agent/integration.js';
import { itineraryInputContractError } from '../../src/main/planning/itinerary-input-contract.js';
import { requiresItineraryPoi } from '../../src/shared/itinerary-activity-kind.js';
import { platformHotelStayGroups } from '../../src/shared/platform-hotel-rules.js';

const raw = 'Day1 出发地-哈尔滨市\\nDay2 漠河接站-龙江第一湾-中国最北点-乌苏里浅滩-北红村篝火晚会\\nDay3 泼水成冰-马拉爬犁-鄂温克使鹿部落-圣诞村-滑雪2小时-北极村\\nDay4 北极星广场-松苑公园-五·六火灾纪念馆-漠河舞厅';
const catalogue: Array<[string, string, number]> = [
  ['龙江第一湾', '龙江第一湾风景区', 91861], ['中国最北点', '中国最北点', 56810159],
  ['乌苏里浅滩', '乌苏里浅滩', 10541112], ['北红村篝火晚会', '北红村', 10541118],
  ['鄂温克使鹿部落', '北极村旅游景区-鄂温克驯鹿园', 71944168], ['圣诞村', '北极圣诞村景区', 18119428],
  ['北极村', '北极村', 86672], ['北极星广场', '北极星广场', 18456561], ['松苑公园', '松苑公园', 86679],
  ['五·六火灾纪念馆', '大兴安岭五六火灾纪念馆', 86682], ['漠河舞厅', '漠河舞厅', 136063426],
];

test('新建空白产品经生产生成、原始资源解析和绑定回读，跨城 POI 与核查任务同步收敛', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vbk-harbin-recurrence-'));
  let db = new VbkDatabase(dir);
  try {
    const created = db.createProduct({ destination: '哈尔滨', days: 4, productForm: 'privateTour', userIdea: raw });
    db.updateProduct(created.id, { ...created.product,
      basicInfo: { ...created.product.basicInfo, province: '黑龙江', subtitle: '原路线极地体验', operationNotes: '按原始路线安排' },
      operations: { ...created.product.operations, pickupCity: '哈尔滨', trafficLine: { enabled: false, variants: [] } },
    });
    for (const [, , poiId] of catalogue) db.saveCachedCtripPoiAvailability({ poiId, status: 'available', openStatus: '营业中',
      latelyOpenTime: null, verifiedAt: new Date().toISOString() });
    const calls: string[] = [];
    const page = { nativeOnly: true, vbkSessionFetch: async (request: any) => {
      const keyword = String(request.body.keyword); calls.push(keyword);
      if (/suggestDistrict/u.test(request.endpoint)) return { status: 200, payload: { ResponseStatus: { Ack: 'Success' },
        districts: ['哈尔滨', '北极村'].includes(keyword) ? [{ districtId: 1, districtName: keyword, districtType: 'City',
          parents: [{ districtName: '黑龙江', districtType: 'Province' }] }] : [] } };
      assert.match(request.endpoint, /suggestPoi/u, '只允许固定资源查询，禁止外部写入或网络');
      const match = catalogue.find(([name]) => keyword === name);
      assert.ok(match, `缺少原始 POI 回放：${keyword}`);
      return { status: 200, payload: { ResponseStatus: { Ack: 'Success' }, poiList: [{ poiName: match[1], poiId: match[2],
        district: { districtName: '漠河', districtType: 'County', parents: [
          { districtName: '大兴安岭', districtType: 'City' }, { districtName: '黑龙江', districtType: 'Province' },
        ] } }] } };
    } };
    const tools = createAgentBusinessTools({ db, browser: { requestPage: async () => page } as never,
      automation: {} as never, productMutations: new ProductMutationService(db),
      productWorkflows: { runExclusive: async (_id: string, _kind: string, work: () => Promise<unknown>) => work(),
        runVbkPageExclusive: async <T>(work: () => Promise<T>) => work() } as never,
      generateStage: async () => { throw new Error('完整原路线不得交给模型重新设计'); },
      disambiguatePoiOption: async ({ candidates }) => ({ pickedText: candidates[0]?.text ?? null, confidence: 0.99 }),
      disambiguateStationOption: async () => ({ pickedText: null, reasoning: '' }), emitProduct: () => undefined,
    });
    const context = { localProductId: created.id, accountKey: 'test', productVersion: 'test' };
    const generated = await tools.find(tool => tool.name === 'generate_product_module')!.execute({ stage: 'itinerary' }, context);
    assert.notEqual(generated.data?.preparationDenied, true, generated.content);
    const resolved = await tools.find(tool => tool.name === 'resolve_itinerary_pois')!.execute({}, context);
    assert.notEqual(resolved.data?.preparationDenied, true, resolved.content);
    db.close(); db = new VbkDatabase(dir);
    const saved = db.getProduct(created.id)!;
    const days = saved.product.itinerary!;
    const required = days.flatMap(day => day.spots ?? []).filter(requiresItineraryPoi);
    assert.equal(required.length, 11);
    assert.ok(required.every(spot => spot.poiId && spot.poiName), '11 个原始景点必须全部通过生产匹配');
    assert.deepEqual(days[2]!.spots!.filter(requiresItineraryPoi).map(spot => spot.name), ['鄂温克使鹿部落', '圣诞村', '北极村']);
    assert.equal(saved.researchTasks.filter(task => task.type === 'vbk' && !['confirmed', 'resolved'].includes(task.state)).length, 0);
    assert.deepEqual(platformHotelStayGroups(saved.product).map(({ cityName, nights }) => ({ cityName, nights })),
      [{ cityName: '哈尔滨', nights: 1 }, { cityName: '漠河', nights: 2 }]);
    assert.equal(days[3]!.hotelCity, undefined);
    assert.equal(saved.product.basicInfo!.userIdea, raw);
    assert.equal(saved.product.basicInfo!.meetingCity, '哈尔滨');
    assert.equal(saved.product.basicInfo!.destinationCity, '哈尔滨');
    assert.equal(itineraryInputContractError(saved, days), undefined);
    assert.ok(calls.includes('北极村'));
    assert.equal(saved.productId, undefined);
    assert.equal(db.getAgentSnapshot(created.id)?.pendingApproval, undefined);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
