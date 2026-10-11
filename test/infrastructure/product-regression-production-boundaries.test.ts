import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCase } from '../../scripts/product-regression/corpus.js';
import { createQueryReplay } from '../../scripts/product-regression/query-replay.js';
import { loadProviderReplay } from '../../scripts/product-regression/provider-replay.js';
import { loadGenerationReplay, installPlanningTransport } from '../../scripts/product-regression/generation-replay.js';
import { suggestPoiDetail } from '../../src/main/infrastructure/poi-suggest.js';
import { MiniMaxService } from '../../src/main/minimax/minimax.js';
import type { VbkSessionRequestBrowser } from '../../src/main/infrastructure/vbk-session-request.js';
import { forbidNetwork } from '../../scripts/product-regression/isolation.js';

test('POI 原始响应必须经过生产名称匹配，不能提供预选 best', async () => {
  const fixture = loadCase('chengdu');
  const provider = loadProviderReplay('chengdu');
  const row = provider.native.find(row => row.endpoint.endsWith('/suggestPoi') && row.request.keyword === '宽窄巷子')!;
  const keyword = row.request.keyword;
  row.payload.poiList[0].localName = '完全不同的景点';
  const replay = createQueryReplay(fixture, provider);
  assert.equal(replay.queries.poi, undefined);
  const page = await replay.browser.requestPage() as unknown as VbkSessionRequestBrowser;
  const detail = await suggestPoiDetail(page, keyword, { destinationCity: '成都', province: '四川' });
  assert.equal(detail.best, null);
  assert.equal(detail.candidates[0].poiName, '完全不同的景点');
});

test('POI、车辆、站点回放必须按实际请求匹配；缺失响应不能复用历史绑定', async () => {
  const fixture = loadCase('xian');
  const provider = loadProviderReplay('xian');
  provider.native = [];
  const replay = createQueryReplay(fixture, provider);
  const page = await replay.browser.requestPage() as unknown as VbkSessionRequestBrowser;
  for (const endpoint of ['suggestPoi', 'suggestAirport', 'suggestTrainStation', 'searchResourceGroup']) {
    await assert.rejects(page.vbkSessionFetch!({ endpoint: `https://online.ctrip.com/restapi/soa2/20049/${endpoint}`,
      body: { keyword: '西安', resourceGroupName: '5座经济' } } as any), /缺少资源查询回放/);
  }
  assert.equal(replay.misses.length, 4);
});

test('消歧缺少固定模型响应时，真实 SDK 和生产解析链明确失败', async () => {
  const isolation = forbidNetwork();
  const trace = loadGenerationReplay('xian');
  const input = trace.disambiguations[0]!;
  trace.disambiguations = [];
  const transport = installPlanningTransport(trace);
  try {
    const service = new MiniMaxService({ apiKey: 'not-a-real-key',
      baseUrl: 'https://model-replay.invalid/v1', model: 'fixed-regression' });
    await assert.rejects(service.disambiguateOption({ kind: 'spot', desired: input.desired,
      candidates: input.candidates as any, product: {} }));
    assert.deepEqual(transport.misses, [`disambiguation:${input.desired}`]);
    assert.deepEqual(isolation.attempts, []);
  } finally { transport.restore(); isolation.restore(); }
});
