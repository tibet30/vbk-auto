import test from 'node:test';
import assert from 'node:assert/strict';
import { readOnlyFetcher, assertReadOnlyRequest, readOnlySession } from '../../scripts/product-regression/read-only-client.js';
import { forbidNetwork } from '../../scripts/product-regression/isolation.js';
import { loadCase, replayPoi } from '../../scripts/product-regression/corpus.js';
import { createQueryReplay } from '../../scripts/product-regression/query-replay.js';
import { loadGenerationReplay } from '../../scripts/product-regression/generation-replay.js';
import { loadProviderReplay } from '../../scripts/product-regression/provider-replay.js';
import { CTRIP_HOTEL_SUGGEST_ENDPOINT } from '../../src/main/infrastructure/ctrip-hotel-search/provider.js';
import type { VbkSessionRequestBrowser } from '../../src/main/infrastructure/vbk-session-request.js';

const POI = 'https://online.ctrip.com/restapi/soa2/20049/suggestPoi';
test('在线核验在发出请求前拒绝创建、保存、上传和未知查询', async () => {
  let calls = 0;
  const client = readOnlyFetcher(async () => { calls++; return new Response('{}'); });
  for (const action of ['saveSaleControlInfo', 'saveProduct', 'uploadImage', 'submitReview', 'unknownQuery']) {
    await assert.rejects(client(`https://online.ctrip.com/restapi/soa2/15638/${action}`, { method: 'POST' }), /只读核验拒绝/);
  }
  await assert.rejects(client(POI, { method: 'DELETE' }), /只读核验拒绝/);
  assert.equal(calls, 0);
});
test('查询凭据只驻留内存且不发送到公开酒店服务；跳转不跟随', async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const client = readOnlyFetcher(async (url, init) => {
    seen.push({ url: String(url), init: init! });
    return new Response('{}');
  }, 'ephemeral-test-ticket');
  await client(POI, { method: 'POST', headers: { authorization: 'discard', cookie: 'discard' }, body: '{}' });
  await client('https://hotels.ctrip.com/hotels/list?cityId=1');
  assert.equal(new Headers(seen[0].init.headers).get('cookie'), 'vbkticket=ephemeral-test-ticket');
  assert.equal(new Headers(seen[0].init.headers).get('authorization'), null);
  assert.equal(new Headers(seen[1].init.headers).get('cookie'), null);
  assert.ok(seen.every(item => item.init.redirect === 'manual'));
  const redirect = readOnlyFetcher(async () => new Response('', { status: 302, headers: { location: 'https://example.com/write' } }));
  await assert.rejects(redirect(POI, { method: 'POST' }), /跳转/);
  assert.throws(() => assertReadOnlyRequest('https://example.com/restapi/soa2/20049/suggestPoi', 'POST'), /拒绝/);
});
test('只读会话拒绝任意页面执行和业务写入上下文', async () => {
  let calls = 0;
  const session = readOnlySession(readOnlyFetcher(async () => { calls++; return new Response('{}'); }));
  await assert.rejects(session.evaluate(() => 1, undefined), /禁止浏览器执行/);
  await assert.rejects(session.vbkSessionFetch!({ endpoint: POI, body: {}, errorLabel: '', headers: {},
    includeCidQuery: false, requireReadableCid: false, businessContext: { businessId: 1, travelType: 1 } }), /禁止业务写入/);
  assert.equal(calls, 0);
});
test('回放缺失不能联网补齐或默认为成功', async () => {
  const fixture = loadCase('xian');
  assert.throws(() => replayPoi(fixture, 100, '未记录景点'), /缺少 POI 回放/);
  assert.throws(() => loadCase('../other'), /未知回归 case/);
  const incomplete = loadCase('chengdu');
  incomplete.poiReplay[0].candidate.poiId = 999999999;
  const first = incomplete.poiReplay[0];
  assert.throws(() => replayPoi(incomplete, first.day, first.keyword), /缺少可信 POI 位置回放/);
  const isolation = forbidNetwork();
  try {
    await assert.rejects(fetch(POI), /禁止网络/);
    assert.deepEqual(isolation.attempts, ['fetch']);
  } finally { isolation.restore(); }
});

test('完整流程固定输入没有资源绑定；缺失酒店和图库查询明确失败', async () => {
  const trace = loadGenerationReplay('rikaze');
  assert.match(trace.input.userIdea!, /二选一/);
  assert.equal(JSON.stringify(trace.stageResponses).includes('hotelCandidates'), false);
  const fixture = loadCase('rikaze');
  const provider = loadProviderReplay('rikaze');
  const keyword = provider.contexts[0].keyword;
  provider.contexts = [];
  provider.covers = [];
  provider.districts = [];
  const replay = createQueryReplay(fixture, provider);
  await assert.rejects(replay.queries.hotelFetch!(CTRIP_HOTEL_SUGGEST_ENDPOINT, { method: 'POST', body: JSON.stringify({ keyword }) }), /缺少资源查询回放/);
  // Known POIs cannot silently imply a recorded empty result.
  await assert.rejects(replay.queries.coverSearch!({} as any, fixture.poiReplay[0].candidate.poiName), /缺少资源查询回放/);
  const page = await replay.browser.requestPage() as unknown as VbkSessionRequestBrowser;
  await assert.rejects(page.vbkSessionFetch!({ endpoint: 'https://online.ctrip.com/restapi/soa2/20049/suggestDistrict',
    body: { keyword: fixture.poiReplay[0].keyword } } as any), /缺少资源查询回放/);
  assert.equal(replay.misses.length, 3);
});
