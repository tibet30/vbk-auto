import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProductSnapshot } from '../../src/main/infrastructure/database/parts/product-draft.js';
import { extractLockedConstraints } from '../../src/main/agent/prompt-helpers.js';
import { classifyItineraryInputMode, itineraryInputContractError } from '../../src/main/planning/itinerary-input-contract.js';
import { findAllVbkCopyBadCases, repairVbkCopyPolicyValue, sanitiseUserIdeaForAi } from '../../src/main/planning/vbk-copy-policy.js';
import { projectCompleteItinerary } from '../../src/main/planning/complete-itinerary-projection.js';
import { hasVerifiedRouteAdministrativeNode } from '../../src/shared/route-administrative-nodes.js';

const raw = 'Day1 出发地-哈尔滨市 \\nDay2 漠河接站-龙江第一湾-中国最北点-乌苏里浅滩-北红村篝火晚会\\nDay3 泼水成冰-马拉爬犁-鄂温克使鹿部落-圣诞村-滑雪2小时-北极村\\nDay4 北极星广场-松苑公园-五·六火灾纪念馆-漠河舞厅';

test('需求原文中的景点名称不能在送入模型前被删除', () => {
  assert.equal(sanitiseUserIdeaForAi(raw), raw);
});

test('官方 POI 和原始路线名称免于文案误改，宣传排名仍被拦截', () => {
  const value = { itinerary: [{ title: '龙江第一湾与中国最北点',
    spots: [{ name: '龙江第一湾', poiName: '龙江第一湾风景区' }, { name: '中国最北点', poiName: '中国北极点' }],
    description: '游览龙江第一湾风景区，提供最佳体验，排名第一。' }] };
  const hits = findAllVbkCopyBadCases(value);
  assert.ok(hits.length > 0);
  assert.ok(hits.every(hit => hit.path.endsWith('.description')));
  const repaired = repairVbkCopyPolicyValue(value) as typeof value;
  assert.deepEqual(repaired.itinerary[0]!.spots, value.itinerary[0]!.spots);
  assert.equal(repaired.itinerary[0]!.title, value.itinerary[0]!.title);
  assert.match(repaired.itinerary[0]!.description, /龙江第一湾风景区/);
  assert.doesNotMatch(repaired.itinerary[0]!.description, /最佳|排名第一/);
  assert.deepEqual(findAllVbkCopyBadCases(repaired), []);
});

for (const marker of ['Day', 'D', '第']) {
  test(`${marker} 逐日路线锁定原名、日期、顺序，拒绝跨日重复添加景点`, () => {
    const source = raw.replace(/Day(\d)/g, (_, day) => marker === '第' ? `第${day}天` : `${marker}${day}`);
    const product = buildProductSnapshot({ destination: '哈尔滨', days: 4, productForm: 'privateTour', userIdea: source });
    const locked = extractLockedConstraints(product);
    assert.equal(classifyItineraryInputMode(locked, 4), 'complete');
    assert.ok(locked.itineraryOrder[1]!.spots.includes('龙江第一湾'));
    const itinerary = locked.itineraryOrder.map(row => ({ day: row.day,
      spots: row.spots.map(name => ({ name, kind: 'attraction' })),
    }));
    itinerary[2]!.spots.unshift({ name: '龙江第一湾', kind: 'attraction' });
    assert.match(itineraryInputContractError(product, itinerary) ?? '', /第 3 天.*不能新增或替换/);
  });
}

test('模型解析的名称和日期不得覆盖原始逐日路线', () => {
  const product = buildProductSnapshot({ destination: '哈尔滨', days: 4, productForm: 'privateTour', userIdea: raw });
  product.planning = { userIntent: { rawIdea: raw, activities: [
    { id: 'wrong', day: 3, title: '龙江重点湾', kind: 'poi', time: '不限' },
  ] } } as never;
  const locked = extractLockedConstraints(product);
  assert.equal(classifyItineraryInputMode(locked, 4, product.planning.userIntent), 'complete');
  assert.ok(locked.itineraryOrder[1]!.spots.includes('龙江第一湾'));
  assert.ok(!locked.itineraryOrder[2]!.spots.includes('龙江重点湾'));
});

test('完整 Day 路线原序投影，独立体验无需伪造 POI，不能用体验隐藏实际景点', () => {
  const product = buildProductSnapshot({ destination: '哈尔滨', days: 4, productForm: 'privateTour', userIdea: raw });
  const output = projectCompleteItinerary(product);
  assert.ok(output);
  const itinerary = output.modules[0]!.value as Array<Record<string, any>>;
  assert.equal(itineraryInputContractError(product, itinerary), undefined);
  assert.ok(itinerary[1]!.spots.some((spot: any) => spot.name === '龙江第一湾'));
  assert.ok(!itinerary[1]!.spots.some((spot: any) => spot.name === '漠河'));
  assert.match(JSON.stringify(itinerary[1]!.activities), /漠河接站/);
  assert.ok(!itinerary[2]!.spots.some((spot: any) => spot.name === '龙江第一湾'));
  assert.ok(itinerary[2]!.spots.some((spot: any) => spot.name === '泼水成冰' && spot.kind === 'other'));
  itinerary[2]!.spots.find((spot: any) => spot.name === '鄂温克使鹿部落').kind = 'other';
  assert.match(itineraryInputContractError(product, itinerary) ?? '', /鄂温克使鹿部落/);
});

test('历史行政误分类凭证不能继续豁免原路线中的村镇景区 POI', () => {
  const product = buildProductSnapshot({ destination: '哈尔滨', days: 4, productForm: 'privateTour', userIdea: raw });
  const itinerary = projectCompleteItinerary(product)!.modules[0]!.value as Array<Record<string, any>>;
  product.product.itinerary = itinerary as never;
  product.product.diagnostics = { routeAdministrativeNodes: [{ day: 3, name: '北极村', districtId: 123 }] };
  itinerary[2]!.spots = itinerary[2]!.spots.filter((spot: any) => spot.name !== '北极村');
  itinerary[2]!.activities = [{ type: 'transport', title: '北极村行政地点与交通衔接', detail: '旧错误分类' }];
  assert.equal(hasVerifiedRouteAdministrativeNode(product.product, '北极村', 3), false);
  assert.match(itineraryInputContractError(product, itinerary) ?? '', /北极村/u);
});
