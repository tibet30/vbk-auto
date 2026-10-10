import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProductSnapshot } from '../../src/main/infrastructure/database/parts/product-draft.js';
import { extractLockedConstraints } from '../../src/main/agent/prompt-helpers.js';
import { itineraryInputContractError } from '../../src/main/planning/itinerary-input-contract.js';

const route = '**10 月 4 号 D1：** 西宁 - 青海湖 - 茶卡盐湖 - 天峻县（天峻石林星空）\n'
  + '**10 月 5 号 D2：** 天峻 - 德令哈 - 大柴旦翡翠湖\n'
  + '**10 月 6 号 D3：** 大柴旦翡翠湖 - 水上雅丹 - 俄博梁（俄博梁星空）\n'
  + '**10 月 7 号 D4：** 俄博梁 - 冷湖（冷湖石油小镇星空）\n'
  + '**10 月 8 号 D5：** 冷湖 - 黑独山 - 瓜州（瓜州星空）\n'
  + '**10 月 9 号 D6：** 瓜州 - 敦煌';
const make = (userIdea: string) => buildProductSnapshot({ destination: '西宁', days: 6, productForm: 'privateTour', userIdea });

for (const heading of ['已确认的住宿要求', '已确认住宿要求', '住宿要求', '住宿安排', '已确认的业务要求', '住宿配置']) {
  test(`${heading}中的晚次与交通要求不能进入最后一天景点约束`, () => {
    const brief = `${route}\n\n${heading}：第1晚住天峻，第2晚住大柴旦，第3晚优先俄博梁附近营地或民宿，接受较低档次；第4晚住冷湖镇，第5晚住瓜州，第6天敦煌结束不住宿。大交通抵达西宁、离开敦煌，同时生成飞机和火车子产品。`;
    const actual = extractLockedConstraints(make(brief));
    assert.deepEqual(actual.itineraryOrder, extractLockedConstraints(make(route)).itineraryOrder);
    assert.deepEqual(actual.itineraryOrder[5], { day: 6, spots: ['瓜州', '敦煌'] });
    assert.ok(!actual.pois.some(poi => /营地|民宿|子产品|晚/.test(poi)));
    const days = actual.itineraryOrder.map(row => ({ day: row.day, spots: row.spots.map(name => ({ name, kind: 'attraction' })) }));
    assert.equal(itineraryInputContractError(make(brief), days), undefined);
  });
}

test('跨行原始路线和真正的最后一天景点仍全部保留', () => {
  const product = make('D1：西宁 - 青海湖\n- 茶卡盐湖\nD2：瓜州 - 敦煌 - 莫高窟');
  assert.deepEqual(extractLockedConstraints(product).itineraryOrder, [
    { day: 1, spots: ['西宁', '青海湖', '茶卡盐湖'] },
    { day: 2, spots: ['瓜州', '敦煌', '莫高窟'] },
  ]);
});
