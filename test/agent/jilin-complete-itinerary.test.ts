import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAgentBusinessTools } from '../../src/main/agent/integration.js';
import { ProductMutationService } from '../../src/main/application/product-mutation-service.js';
import { VbkDatabase } from '../../src/main/infrastructure/database/database.js';
import { buildProductSnapshot } from '../../src/main/infrastructure/database/parts/product-draft.js';
import { projectCompleteItinerary } from '../../src/main/planning/complete-itinerary-projection.js';
import { itineraryInputContractError } from '../../src/main/planning/itinerary-input-contract.js';
import { itineraryStructureError } from '../../src/main/planning/itinerary-structure.js';
import { itineraryPoisAreComplete } from '../../src/main/planning/runtime.js';
import { computeReadiness } from '../../src/main/readiness.js';
import { forbidNetwork } from '../../scripts/product-regression/isolation.js';
import { isPersistedRouteTravelNode } from '../../src/shared/itinerary-route-travel-node.js';

const ROUTE = '第一天吉林集合-24h接机-入住酒店-自由活动 第二天吉林-雾凇长廊-松花湖（滑雪、雪圈）-云顶市集-二道温泉酒店 第三天二道-雾淞漂流-长白山北景区&天池/长白瀑布/小天池/地下森林-网红弹幕墙-延吉 第四天延吉-本地宝藏点/朝鲜古村落-镜泊湖冰封冬捕/冰上娱乐-牡丹江 第五天牡丹江-横道河子百年小镇&机车库&油画村-雪乡轻旅拍体验-雪韵大街&棒槌山雪乡夜景&雪地蹦迪-雪乡 第六天雪乡-雪域主峰秘境穿越&雪地摩托/轻徒步-东北原始交通工具“马拉爬犁”-哈尔滨 第七天哈尔滨-索菲亚教堂-中央大街-防洪纪念塔-中华巴洛克 老道外-哈尔滨14:00送站/15:00抵达机场送机,建议17:00以后航班';
function blank() {
  const initial = buildProductSnapshot({ destination: '吉林', days: 7, productForm: 'privateTour', userIdea: ROUTE });
  Object.assign(initial.product.basicInfo!, { province: '吉林', days: 7, nights: 6, meetingCity: '吉林', destinationCity: '吉林' });
  Object.assign(initial.product.operations!, { transport: 'charter', pickupCity: '吉林', trafficLine: { enabled: false, variants: [] } });
  initial.product.itinerary = [];
  return initial;
}
function projected() {
  const initial = blank();
  const output = projectCompleteItinerary(initial);
  assert.ok(output, '完整吉林原文应直接进入结构化生成，不交给模型重新设计七天行程');
  const itinerary = output.modules[0]!.value as Array<Record<string, any>>;
  assert.equal(itinerary.length, 7);
  assert.equal(itineraryStructureError({ ...initial.product, itinerary }), undefined);
  assert.equal(itineraryInputContractError(initial, itinerary), undefined);
  return { initial, itinerary };
}

test('吉林原始七日行程从空白产品投影，保留接送时间、原日序和真实 POI', () => {
  const { initial, itinerary } = projected();
  assert.deepEqual(itinerary.map(day => day.day), [1, 2, 3, 4, 5, 6, 7]);
  assert.match(JSON.stringify(itinerary[0]), /24h接机/);
  assert.match(JSON.stringify(itinerary[0]), /自由活动/);
  assert.ok(!itinerary[0]!.spots.some((spot: any) => spot.kind === 'attraction'));
  for (const value of ['14:00送站', '15:00抵达机场送机', '17:00以后航班']) assert.ok(JSON.stringify(itinerary[6]).includes(value));
  for (const [day, names] of [[2, ['雾凇长廊', '松花湖', '云顶市集']],
    [3, ['雾淞漂流', '长白山北景区', '天池', '长白瀑布', '小天池', '地下森林', '网红弹幕墙']],
    [4, ['朝鲜古村落']], [5, ['横道河子百年小镇', '机车库', '油画村', '雪韵大街', '棒槌山雪乡夜景']],
    [7, ['索菲亚教堂', '中央大街', '防洪纪念塔', '中华巴洛克 老道外']]] as const) {
    const spots = itinerary[day - 1]!.spots as any[];
    for (const name of names) assert.ok(spots.some(spot => spot.name === name && spot.kind === 'attraction'), `第${day}天保留${name}`);
  }
  for (const [day, names] of [[4, ['本地宝藏点', '镜泊湖冰封冬捕', '冰上娱乐']],
    [5, ['雪乡轻旅拍体验', '雪地蹦迪']], [6, ['雪域主峰秘境穿越', '轻徒步', '东北原始交通工具“马拉爬犁”']]] as const) {
    const spots = itinerary[day - 1]!.spots as any[];
    for (const name of names) assert.ok(spots.some(spot => spot.name === name && spot.kind === 'other'), `第${day}天把${name}识别为活动`);
  }
  assert.ok(!itinerary.flatMap(day => day.spots).some(spot => spot.name.includes('&')), '复合景点必须拆成独立 POI');
  for (const [day, anchor] of [[3, '延吉'], [4, '牡丹江'], [5, '雪乡'], [6, '哈尔滨']] as const) {
    assert.ok(!(itinerary[day - 1]!.spots as any[]).some(spot => spot.name === anchor && spot.kind === 'attraction'),
      `第${day}天不应把路线锚点${anchor}当成景点`);
  }
  assert.ok(!itinerary[2]!.spots.some((spot: any) => spot.name === '二道'));
  assert.match(String(itinerary[2]!.description), /二道/);
  assert.ok(itinerary.flatMap(day => day.spots).every(spot => !spot.poiId && !spot.poiName));
  const rawDays = ROUTE.split(/第[一二三四五六七]天/u).slice(1);
  for (const [index, source] of rawDays.entries()) assert.ok(String(itinerary[index]!.description).includes(source.trim()));
  assert.equal(initial.product.basicInfo!.userIdea, ROUTE);
  assert.equal(itinerary[6]!.hotel, '无');
});

test('原文自由活动可写为活动，删除安排或把真实景点伪装成自由活动仍失败', () => {
  const { initial, itinerary } = projected();
  itinerary[0]!.spots = itinerary[0]!.spots.filter((spot: any) => spot.name !== '自由活动');
  itinerary[0]!.activities = [{ time: '不限', type: 'free', title: '自由活动', detail: '按原定安排' }];
  assert.equal(itineraryInputContractError(initial, itinerary), undefined);
  itinerary[0]!.activities = [];
  assert.match(itineraryInputContractError(initial, itinerary) ?? '', /自由活动/);
  itinerary[0]!.activities = [{ time: '不限', type: 'free', title: '自由活动', detail: '按原定安排' }];
  itinerary[2]!.spots.find((spot: any) => spot.name === '长白山北景区').kind = 'free';
  assert.match(itineraryInputContractError(initial, itinerary) ?? '', /景点类型.*长白山北景区/);
});

test('住宿出发点识别只接受相邻原文证据，真实 POI 和已绑定地点不能被降级', () => {
  const initial = blank();
  const day = { day: 3, title: '二道 · 雾淞漂流', spots: [] };
  assert.equal(isPersistedRouteTravelNode(initial.product, day, '二道'), true);
  initial.product.basicInfo!.userIdea = ROUTE.replace('二道温泉酒店', '二道');
  assert.equal(isPersistedRouteTravelNode(initial.product, day, '二道'), false);
  initial.product.basicInfo!.userIdea = ROUTE.replaceAll('二道', '松花湖');
  assert.equal(isPersistedRouteTravelNode(initial.product, { ...day, title: '松花湖 · 雾淞漂流' }, '松花湖'), false);
  initial.product.basicInfo!.userIdea = ROUTE;
  assert.equal(isPersistedRouteTravelNode(initial.product, { ...day, spots: [{ name: '二道', poiId: 123, poiName: '二道' }] }, '二道'), false);
});

test('吉林原文经生产生成工具、保存及独立回读完成结构化；资源与审批门禁保持阻塞', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'vbk-jilin-blank-'));
  const db = new VbkDatabase(directory);
  const network = forbidNetwork();
  const writes: string[] = [];
  const automation = new Proxy({}, { get: (_target, name) => () => { writes.push(String(name)); throw new Error('禁止携程写入'); } });
  let reader: VbkDatabase | undefined;
  let modelCalls = 0;
  try {
    const initial = db.createProduct({ destination: '吉林', days: 7, productForm: 'privateTour', userIdea: ROUTE });
    const mutations = new ProductMutationService(db);
    mutations.replace(initial.id, blank().product);
    assert.deepEqual(db.getProduct(initial.id)!.product.itinerary, []);
    const tools = createAgentBusinessTools({
      db, browser: undefined as any, automation: automation as any,
      productWorkflows: {
        runExclusive: async (_id: string, _kind: string, work: () => Promise<unknown>) => work(),
        runVbkPageExclusive: async <T>(work: () => Promise<T>) => work(),
      } as any,
      productMutations: mutations,
      generateStage: async () => { modelCalls++; throw new Error('不允许模型重排原始七日路线'); },
      disambiguatePoiOption: async () => ({ pickedText: null, confidence: 0 }),
      disambiguateStationOption: async () => ({ pickedText: null, reasoning: '' }), emitProduct: () => undefined,
    });
    const tool = tools.find(item => item.name === 'generate_product_module')!;
    await tool.execute({ stage: 'itinerary' }, { localProductId: initial.id, accountKey: 'isolated', productVersion: 'test' });
    assert.equal(modelCalls, 0);
    reader = new VbkDatabase(directory);
    const saved = reader.getProduct(initial.id)!;
    assert.equal(saved.product.itinerary!.length, 7);
    assert.equal(itineraryStructureError(saved.product), undefined);
    assert.equal(itineraryInputContractError(saved, saved.product.itinerary), undefined);
    assert.equal(saved.product.basicInfo!.userIdea, ROUTE);
    assert.equal(saved.product.basicInfo!.meetingCity, '吉林');
    assert.equal(saved.product.basicInfo!.destinationCity, '吉林');
    assert.match(JSON.stringify(saved.product.itinerary![6]), /14:00送站/);
    const readiness = computeReadiness({ product: saved.product, researchTasks: saved.researchTasks });
    assert.equal(readiness.ready, false);
    assert.equal(itineraryPoisAreComplete(saved.product.itinerary as unknown[]), false);
    assert.ok(readiness.issues.length > 0);
    assert.ok(saved.product.itinerary!.flatMap(day => day.spots ?? []).some(spot => spot.name === '朝鲜古村落' && !spot.poiId));
    assert.equal(reader.getAgentSnapshot(initial.id)?.pendingApproval, undefined);
    assert.notEqual(reader.getAgentSnapshot(initial.id)?.run?.status, 'waiting_approval');
    assert.deepEqual(network.attempts, []);
    assert.deepEqual(writes, []);
  } finally {
    network.restore(); reader?.close(); db.close(); rmSync(directory, { recursive: true, force: true });
  }
});
