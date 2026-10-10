import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProductSnapshot } from '../../src/main/infrastructure/database/parts/product-draft.js';
import { itineraryInputContractError } from '../../src/main/planning/itinerary-input-contract.js';
import { agentPatchOperations } from '../../src/main/agent/integration-patch.js';

function fixture() {
  const product = buildProductSnapshot({ destination: '西宁', days: 2, productForm: 'privateTour',
    userIdea: '**10 月 4 号 D1：** 西宁 - 青海湖 - 茶卡盐湖 - 天峻县（天峻石林星空）\n**10 月 5 号 D2：** 天峻 - 德令哈 - 大柴旦翡翠湖' });
  product.product.itinerary = [];
  const itinerary = [
    { day: 1, description: '西宁 - 青海湖 - 茶卡盐湖 - 天峻县（天峻石林星空）', spots: [{ name: '西宁', kind: 'other' }, { name: '青海湖', kind: 'attraction' },
      { name: '茶卡盐湖', kind: 'attraction' }, { name: '天峻县', kind: 'other' }] },
    { day: 2, description: '天峻 - 德令哈 - 大柴旦翡翠湖', spots: [{ name: '天峻', kind: 'attraction' }, { name: '德令哈', kind: 'attraction' },
      { name: '大柴旦翡翠湖', kind: 'attraction' }] },
  ];
  return { product, itinerary };
}

test('original optional administrative nodes can be retained or omitted through the real patch guard', () => {
  const { product, itinerary } = fixture();
  assert.equal(itineraryInputContractError(product, itinerary), undefined);
  assert.doesNotThrow(() => agentPatchOperations(product, { itinerary }));
  itinerary[0]!.spots = itinerary[0]!.spots.slice(1, 3);
  assert.equal(itineraryInputContractError(product, itinerary), undefined);
});

test('optional route nodes do not permit an unrequested city or a disguised extra attraction', () => {
  for (const kind of ['other', 'free', 'attraction']) {
    const { product, itinerary } = fixture();
    itinerary[0]!.spots.push({ name: '成都', kind });
    assert.match(itineraryInputContractError(product, itinerary) ?? '', /不能新增或替换景点：成都/);
  }
});

test('retaining administrative nodes cannot hide, remove or reorder a locked attraction', () => {
  const { product, itinerary } = fixture();
  itinerary[0]!.spots[1]!.kind = 'other';
  assert.match(itineraryInputContractError(product, itinerary) ?? '', /不能用自由活动或其他活动隐藏：青海湖/);
  itinerary[0]!.spots[1]!.kind = 'attraction';
  [itinerary[0]!.spots[1], itinerary[0]!.spots[2]] = [itinerary[0]!.spots[2]!, itinerary[0]!.spots[1]!];
  assert.match(itineraryInputContractError(product, itinerary) ?? '', /禁止整体重排或替换/);
  itinerary[0]!.spots.splice(1, 1);
  assert.match(itineraryInputContractError(product, itinerary) ?? '', /缺失：茶卡盐湖/);
});

test('native district receipts exempt only the verified day and require a positive district ID', () => {
  const { product, itinerary } = fixture();
  itinerary[1]!.spots = itinerary[1]!.spots.filter(spot => spot.name !== '德令哈');
  (product.product as any).diagnostics = { routeAdministrativeNodes: [{ day: 2, name: '德令哈', districtId: 12 }] };
  assert.equal(itineraryInputContractError(product, itinerary), undefined);
  (product.product as any).diagnostics.routeAdministrativeNodes[0].day = 1;
  assert.match(itineraryInputContractError(product, itinerary) ?? '', /缺失：德令哈/);
  (product.product as any).diagnostics.routeAdministrativeNodes[0] = { day: 2, name: '德令哈', districtId: 0 };
  assert.match(itineraryInputContractError(product, itinerary) ?? '', /缺失：德令哈/);
  assert.throws(() => agentPatchOperations(product, { diagnostics: { routeAdministrativeNodes: [] } }), /不允许修改字段/);
});
