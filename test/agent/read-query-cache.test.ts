import assert from "node:assert/strict";
import test from "node:test";
import { isCacheableReadQuery, readQueryCacheKey, ReadQueryCache } from "../../src/main/agent/read-query-cache.js";

test("仅景点与站点查询参与去重缓存", () => {
  assert.equal(isCacheableReadQuery("query_poi"), true);
  assert.equal(isCacheableReadQuery("query_station"), true);
  assert.equal(isCacheableReadQuery("read_product"), false);
  assert.equal(isCacheableReadQuery("query_hotel_resource"), false);
});

test("相同产品、run、工具与参数生成同一缓存键", () => {
  const a = readQueryCacheKey({
    localProductId: "p1", runId: "r1", name: "query_poi", arguments: { keyword: " 帕拉庄园 " },
  });
  const b = readQueryCacheKey({
    localProductId: "p1", runId: "r1", name: "query_poi", arguments: { keyword: "帕拉庄园" },
  });
  const c = readQueryCacheKey({
    localProductId: "p1", runId: "r1", name: "query_poi", arguments: { keyword: "白居寺" },
  });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("缓存命中后可复用内容，并按 run 清理", () => {
  const cache = new ReadQueryCache();
  const key = readQueryCacheKey({
    localProductId: "p1", runId: "r1", name: "query_station", arguments: { keyword: "日喀则", kind: "train" },
  });
  cache.set(key, '{"ok":true}');
  assert.equal(cache.get(key), '{"ok":true}');
  cache.clearRun("p1", "r1");
  assert.equal(cache.get(key), undefined);
});
