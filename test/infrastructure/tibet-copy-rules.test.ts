import test from "node:test";
import assert from "node:assert/strict";
import { createTibetCopyRuleSync, exportLocalCopyRules } from "../../src/main/infrastructure/tibet-copy-rules.js";
import { cachedPresentationWords, copyRuleCacheKey } from "../../src/shared/vbk-copy-rules.js";
import type { AppAuthStore } from "../../src/main/infrastructure/app-auth-store.js";

function fixture() {
  let userId = 3;
  const auth = { get: () => ({ token: "secret", user: { id: userId } }) } as AppAuthStore;
  const cache = new Map<string, string>();
  const calls: Array<{ method: string; body?: any }> = [];
  let fail = false;
  let missing = false;
  const rows = exportLocalCopyRules(["江鲜"]).map(rule => ({ ...rule, enabled: true }));
  rows.push({ ...rows.at(-1)!, key: 'other-device-word', term: '其他反馈词' });
  const fetchImpl = async (_url: any, init: any) => {
    calls.push({ method: init.method, body: init.body && JSON.parse(init.body) });
    if (fail) throw new Error("offline");
    return new Response(JSON.stringify({ code: 200, data: { version: 'a'.repeat(64), rules: missing ? [] : rows } }), { status: 200 });
  };
  const sync = createTibetCopyRuleSync(auth, { listLocalRejectedPresentationWords: () => ['江鲜'], setSetting: (k,v) => { cache.set(k,v); } }, { baseUrl: 'https://example.test', fetchImpl: fetchImpl as typeof fetch });
  return { sync, cache, calls, rows, set fail(v: boolean) { fail = v; }, set missing(v: boolean) { missing = v; }, set userId(v: number) { userId = v; } };
}

test("内置规则及江鲜一并上传，只携带词条元数据，POST后独立GET缓存", async () => {
  const f = fixture();const result = await f.sync.sync();
  assert.equal(result.count, 19);assert.deepEqual(f.calls.map(x=>x.method), ['POST','GET']);
  assert.equal(f.calls[0]!.body.rules.length, 18);
  assert.ok(f.calls[0]!.body.rules.some((r:any)=>r.term==='江鲜'));
  assert.ok(!JSON.stringify(f.calls[0]!.body).includes('secret'));
  assert.deepEqual(cachedPresentationWords(f.cache.get(copyRuleCacheKey(3))).slice(-2), ['江鲜','其他反馈词']);
});

test("离线或回读缺词保留有效缓存，不把同步失败当成功", async () => {
  const f = fixture();await f.sync.sync();const before=f.cache.get(copyRuleCacheKey(3));
  f.fail=true;await assert.rejects(f.sync.sync(), /offline/);assert.equal(f.cache.get(copyRuleCacheKey(3)),before);
  f.fail=false;f.missing=true;await assert.rejects(f.sync.sync(),/缺少上传词条/);assert.equal(f.cache.get(copyRuleCacheKey(3)),before);
});

test("请求等待期间账号切换不应用旧账号快照，并发同步共享请求", async () => {
  const f=fixture();const first=f.sync.sync();const second=f.sync.sync();f.userId=4;
  await assert.rejects(first,/账号已切换/);await assert.rejects(second,/账号已切换/);assert.equal(f.calls.length,2);assert.equal(f.cache.size,0);
});

test("缓存只用于启用的字面图文词，排除行程规则和复杂内置策略", () => {
  const f=fixture();const r=f.rows.at(-1)!;
  const snapshot={version:'a'.repeat(64),rules:[{...r,term:'关闭词',enabled:false},{...r,term:'行程词',module:'itinerary'},{...r,term:'复杂策略',matchKind:'builtin_policy'},r]};
  assert.deepEqual(cachedPresentationWords(JSON.stringify(snapshot)),['其他反馈词']);assert.deepEqual(cachedPresentationWords('bad json'),[]);
});
