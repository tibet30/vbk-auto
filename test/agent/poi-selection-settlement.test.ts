import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { VbkDatabase } from '../../src/main/infrastructure/database/database.js';
import { ProductMutationService } from '../../src/main/application/product-mutation-service.js';
import { createAgentBusinessTools } from '../../src/main/agent/integration.js';
import { refreshSatisfiedResearchTasks } from '../../src/main/operations/research-refresh.js';

test('Agent 别名选点成功后同步结清歧义任务，后续刷新不重开任务', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'vbk-agent-poi-'));
  const db = new VbkDatabase(directory);
  try {
    const product = db.createProduct({ destination: '漠河', days: 1, productForm: 'privateTour' });
    db.updateProduct(product.id, { ...product.product,
      basicInfo: { ...product.product.basicInfo, province: '黑龙江', subtitle: '漠河游览', operationNotes: '按原路线' },
      operations: { ...product.product.operations, pickupCity: '漠河', transport: 'charter' },
      itinerary: [{ day: 1, title: '漠河游览', description: '游览龙江湾', hotel: '无', meals: '自理',
        spots: [{ name: '龙江湾', kind: 'attraction', poiId: null, poiName: null }] }],
    });
    const taskId = db.addResearchTask(product.id, { type: 'vbk', label: '核查 龙江湾 的 VBK POI 映射',
      detail: '已找到多个候选 POI，但程序无法安全确定唯一地点；请手动选择 POI' });
    db.saveCachedCtripPoiAvailability({ poiId: 91861, status: 'available', openStatus: '营业中', latelyOpenTime: null,
      verifiedAt: new Date().toISOString() });
    const page = { evaluate: async () => ({ status: 200, durationMs: 1, ctx: {}, payload: {
      ResponseStatus: { Ack: 'Success' }, poiList: [{ poiName: '龙江第一湾风景区', poiId: 91861,
        district: { districtName: '漠河', districtType: 'County', parents: [
          { districtName: '大兴安岭', districtType: 'City' }, { districtName: '黑龙江', districtType: 'Province' },
        ] } }],
    } }) };
    let emitted = 0;
    const tools = createAgentBusinessTools({ db, browser: { requestPage: async () => page } as never,
      automation: {} as never, productMutations: new ProductMutationService(db),
      productWorkflows: { runExclusive: async (_id: string, _kind: string, work: () => Promise<unknown>) => work(),
        runVbkPageExclusive: async <T>(work: () => Promise<T>) => work() } as never,
      generateStage: async () => { throw new Error('不得重新生成行程'); },
      disambiguatePoiOption: async () => ({ pickedText: null, confidence: 0 }),
      disambiguateStationOption: async () => ({ pickedText: null, reasoning: '' }), emitProduct: () => { emitted += 1; },
    });
    const tool = tools.find(tool => tool.name === 'select_itinerary_poi')!;
    const args = { day: 1, spotName: '龙江湾', queryKeyword: '龙江第一湾', poiId: 91861 };
    const context = { localProductId: product.id, accountKey: 'test', productVersion: 'test' };
    const confirm = db.confirmVerifiedPoiResearchTasks;
    db.confirmVerifiedPoiResearchTasks = () => { throw new Error('结清保存失败'); };
    await assert.rejects(tool.execute(args, context), /结清保存失败/);
    assert.equal(db.getProduct(product.id)!.product.itinerary![0]!.spots![0]!.poiId, null);
    assert.equal(db.getProduct(product.id)!.researchTasks.find(task => task.id === taskId)!.state, 'researching');
    assert.equal(emitted, 0, '未完整落库的选点不能广播成功');
    db.confirmVerifiedPoiResearchTasks = confirm;
    const result = await tool.execute(args, context);
    assert.match(result.content, /"poiId": 91861/);
    const task = db.getProduct(product.id)!.researchTasks.find(task => task.id === taskId)!;
    assert.equal(task.state, 'confirmed');
    assert.equal(task.detail, '当前行程已保存有效的 VBK POI 映射。');
    assert.match(task.evidence.at(-1)!.title, /\[itinerary-poi:verified\].*龙江湾.*91861/);
    refreshSatisfiedResearchTasks(db, product.id);
    assert.equal(db.getProduct(product.id)!.researchTasks.find(task => task.id === taskId)!.state, 'confirmed');
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
