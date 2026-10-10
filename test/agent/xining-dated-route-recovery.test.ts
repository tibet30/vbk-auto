import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildProductSnapshot } from '../../src/main/infrastructure/database/parts/product-draft.js';
import { VbkDatabase } from '../../src/main/infrastructure/database/database.js';
import { ProductMutationService } from '../../src/main/application/product-mutation-service.js';
import { createAgentBusinessTools } from '../../src/main/agent/integration.js';
import { projectCompleteItinerary } from '../../src/main/planning/complete-itinerary-projection.js';
import { itineraryInputContractError } from '../../src/main/planning/itinerary-input-contract.js';
import { normaliseNumberedRouteAdministrativeNodes } from '../../src/main/planning/numbered-route-administrative.js';

const idea = `**10 月 4 号 D1：** 西宁 - 青海湖 - 茶卡盐湖 - 天峻县（天俊石林星空）
**10 月 5 号 D2：** 天峻 - 德令哈 - 大柴旦翡翠湖
**10 月 6 号 D3：** 大柴旦翡翠湖 - 水上雅丹 - 俄博梁（俄博梁星空）
**10 月 7 号 D4：** 俄博梁 - 冷湖（冷湖石油小镇星空）
**10 月 8 号 D5：** 冷湖 - 黑独山 - 瓜州（瓜州星空）
**10 月 9 号 D6：** 瓜州 - 敦煌`;

function fixture() {
  const p = buildProductSnapshot({ destination: '西宁', days: 6, productForm: 'privateTour', userIdea: idea });
  Object.assign(p.product.basicInfo!, { province: '青海', subtitle: '星空路线', operationNotes: '保留原始路线' });
  Object.assign(p.product.operations!, { pickupCity: '西宁', transport: 'charter', hotelTier: '当地5钻酒店/-38' });
  p.product.itinerary = [];
  return p;
}

test('six-day recovery preserves repeated attractions and all four original night notes', () => {
  const p = fixture();
  const itinerary = projectCompleteItinerary(p)!.modules[0]!.value as any[];
  assert.equal(itinerary.length, 6);
  assert.equal(itineraryInputContractError(p, itinerary), undefined);
  assert.deepEqual(itinerary.slice(0, 5).map(day => day.hotel), ['天峻县区域酒店（待核验）', '大柴旦翡翠湖区域酒店（待核验）',
    '俄博梁区域酒店（待核验）', '冷湖区域酒店（待核验）', '瓜州区域酒店（待核验）']);
  assert.equal(itinerary[5].hotel, '无');
  assert.ok(itinerary[2].spots.some((spot: any) => spot.name === '大柴旦翡翠湖'));
  assert.deepEqual(itinerary.flatMap(day => day.activities.filter((a: any) => a.type === 'other').map((a: any) => a.title)),
    ['天俊石林星空', '俄博梁星空', '冷湖石油小镇星空', '瓜州星空']);
  const missing = structuredClone(itinerary);
  missing[2].spots.shift();
  assert.match(itineraryInputContractError(p, missing) ?? '', /缺失：大柴旦翡翠湖/);
  const reordered = structuredClone(itinerary);
  [reordered[0].spots[1], reordered[0].spots[2]] = [reordered[0].spots[2], reordered[0].spots[1]];
  assert.match(itineraryInputContractError(p, reordered) ?? '', /禁止整体重排/);
  const lostNote = structuredClone(itinerary);
  lostNote[0].description = '西宁 - 青海湖 - 茶卡盐湖 - 天峻县';
  lostNote[0].activities = [];
  assert.match(itineraryInputContractError(p, lostNote) ?? '', /天俊石林星空/);
});

test('native administrative normalization removes only confirmed cities and keeps their route text', async () => {
  const p = fixture();
  p.product.itinerary = projectCompleteItinerary(p)!.modules[0]!.value as any;
  const admins = new Set(['西宁', '天峻', '天峻县', '德令哈', '冷湖', '瓜州', '敦煌']);
  const result = await normaliseNumberedRouteAdministrativeNodes(p, { nativeOnly: true, vbkSessionFetch: async (request: any) => {
    const name = request.body.keyword;
    return { status: 200, payload: { ResponseStatus: { Ack: 'Success' }, districts: admins.has(name) ? [{
      districtId: 12, districtName: name, districtType: 'City', parents: [{ districtName: '甘肃', districtType: 'Province' }],
    }] : [] } };
  } } as any);
  assert.ok(result);
  p.product.itinerary = result.itinerary as any;
  (p.product as any).diagnostics.routeAdministrativeNodes = result.converted;
  assert.equal(itineraryInputContractError(p, p.product.itinerary), undefined);
  assert.ok(!p.product.itinerary!.flatMap(day => day.spots ?? []).some(spot => admins.has(spot.name)));
  assert.deepEqual(p.product.itinerary![2]!.spots!.map(spot => spot.name), ['大柴旦翡翠湖', '水上雅丹', '俄博梁']);
  const lostCity = structuredClone(p.product.itinerary) as any[];
  lostCity[1].title = '天峻到大柴旦翡翠湖'; lostCity[1].description = lostCity[1].title; lostCity[1].activities = [];
  assert.match(itineraryInputContractError(p, lostCity) ?? '', /德令哈/);
});

test('real generation tool recovers the empty itinerary without model retries and persists after reopen', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vbk-xining-dated-'));
  let db = new VbkDatabase(dir);
  try {
    const p = fixture();
    (p.product.operations as any).trafficLine = { enabled: false, variants: [], availability: { availableVariants: [], unavailableVariants: {} } };
    db.importProductSnapshot(p);
    const tools = createAgentBusinessTools({ db, browser: undefined as any, automation: {} as any,
      productMutations: new ProductMutationService(db), productWorkflows: {
        runExclusive: async (_id: string, _kind: string, work: any) => work(), runVbkPageExclusive: async (work: any) => work(),
      } as any,
      generateStage: async () => { throw new Error('unexpected model redesign'); },
      disambiguatePoiOption: async () => ({ pickedText: null, confidence: 0 }),
      disambiguateStationOption: async () => ({ pickedText: null, reasoning: '' }), emitProduct: () => undefined });
    await tools.find(tool => tool.name === 'generate_product_module')!.execute({ stage: 'itinerary' },
      { localProductId: p.id, accountKey: 'a', productVersion: 'v' });
    db.close(); db = new VbkDatabase(dir);
    const saved = db.getProduct(p.id)!;
    assert.equal(saved.product.itinerary!.length, 6);
    assert.equal(itineraryInputContractError(saved, saved.product.itinerary), undefined);
    assert.equal(saved.product.basicInfo!.meetingCity, '西宁');
    assert.equal(saved.product.basicInfo!.destinationCity, '西宁');
    assert.match(JSON.stringify(saved.product.itinerary![3]!.activities), /冷湖石油小镇星空/);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
