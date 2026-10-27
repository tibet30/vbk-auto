import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { VbkDatabase } from '../../../src/main/infrastructure/database/database.js';
import { ProductMutationService } from '../../../src/main/application/product-mutation-service.js';
import { createAgentBusinessTools } from '../../../src/main/agent/integration.js';
import { resolveAdministrativeRouteNodes } from '../../../src/main/agent/integration-route-administrative.js';
import { forbidNetwork } from '../../../scripts/product-regression/isolation.js';

export const source = JSON.parse(readFileSync(new URL('./route.json', import.meta.url), 'utf8'));
type Json = Record<string, any>;

/** Only query responses are projected. No imported plan, bindings, approvals or account sessions. */
export async function lhasaFixture(t: TestContext, mutate?: (records: Json) => void,
  status: 'available' | 'suspended' = 'available') {
  const directory = mkdtempSync(path.join(tmpdir(), 'vbk-lhasa-poi-'));
  const db = new VbkDatabase(directory);
  const network = forbidNetwork();
  t.after(() => {
    db.close(); network.restore(); rmSync(directory, { recursive: true, force: true });
    assert.deepEqual(network.attempts, []);
  });
  const records = JSON.parse(readFileSync(new URL('./queries.json', import.meta.url), 'utf8'));
  mutate?.(records);
  const requested: string[] = [];
  const page = { nativeOnly: true, vbkSessionFetch: async (request: Json) => {
    const keyword = request.body.keyword;
    requested.push(`${request.endpoint}:${keyword}`);
    let payload: Json;
    if (request.endpoint.includes('/suggestDistrict')) {
      assert.ok(Object.hasOwn(records.administrative, keyword), `缺行政回放：${keyword}`);
      payload = { districts: records.administrative[keyword] ? [records.administrative[keyword]] : [] };
    } else if (request.endpoint.includes('/suggestPoi')) {
      assert.ok(Object.hasOwn(records.poi, keyword), `缺 POI 回放：${keyword}`);
      const value = records.poi[keyword];
      payload = { poiList: Array.isArray(value) ? value : [value] };
    } else throw new Error(`禁止平台写入或未记录请求：${request.endpoint}`);
    return { status: 200, payload: { ResponseStatus: { Ack: 'Success' }, ...payload } };
  } };
  const initial = db.createProduct({ destination: '拉萨', days: 7, productForm: 'privateTour', userIdea: source.userIdea });
  const mutations = new ProductMutationService(db);
  mutations.replace(initial.id, { ...initial.product, basicInfo: { ...initial.product.basicInfo, province: '西藏' },
    operations: { ...initial.product.operations, pickupCity: '拉萨', transport: 'charter',
      trafficLine: { enabled: true, variants: ['flightRoundTrip', 'trainRoundTrip'] } } });
  assert.deepEqual(db.getProduct(initial.id)!.product.itinerary, []);
  for (const value of Object.values(records.poi).flat() as Json[]) db.saveCachedCtripPoiAvailability({
    poiId: value.poiId, status, openStatus: status === 'available' ? '营业中' : '暂停营业', latelyOpenTime: null,
    verifiedAt: new Date().toISOString(),
  });
  const deps = {
    db, productMutations: mutations, browser: undefined as any,
    automation: new Proxy({}, { get: () => () => { throw new Error('禁止携程写入'); } }) as any,
    productWorkflows: { runExclusive: async (_id: string, _kind: string, work: () => Promise<unknown>) => work(),
      runVbkPageExclusive: async <T>(work: () => Promise<T>) => work() } as any,
    generateStage: async () => { throw new Error('不得用模型重排原路线'); },
    disambiguatePoiOption: async () => ({ pickedText: null, confidence: 0 }),
    disambiguateStationOption: async () => ({ pickedText: null, reasoning: '' }), emitProduct: () => undefined,
  };
  const ctx = { localProductId: initial.id, accountKey: 'isolated', productVersion: 'test' };
  const generation = createAgentBusinessTools(deps).find(tool => tool.name === 'generate_product_module')!;
  const generatedResult = await generation.execute({ stage: 'itinerary' }, ctx);
  const generated = db.getProduct(initial.id)!;
  assert.equal(generated.product.itinerary!.length, 7, generatedResult.content);
  assert.ok(generated.product.itinerary!.flatMap(day => day.spots ?? []).every(spot => !spot.poiId && !spot.poiName));
  deps.browser = { requestPage: async () => page } as any;
  await resolveAdministrativeRouteNodes(generated, deps, async work => work());
  const tools = createAgentBusinessTools(deps);
  const execute = async (name: string, args: Json) => tools.find(tool => tool.name === name)!.execute(args, ctx);
  const read = () => {
    const reader = new VbkDatabase(directory);
    try { return { detail: reader.getProduct(initial.id)!, snapshot: reader.getAgentSnapshot(initial.id) }; }
    finally { reader.close(); }
  };
  return { db, id: initial.id, mutations, execute, read, requested, browser: deps.browser };
}
