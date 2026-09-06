import assert from "node:assert/strict";
import test from "node:test";
import { compactPoiQueryResult, poiCandidatesForAvailability } from "../../src/main/agent/poi-query-compact.js";

test("query_poi 精简结果远小于截断上限，且保留 usableDecision", () => {
  const candidates = Array.from({ length: 80 }, (_, index) => ({
    index,
    poiName: `景点${index}`,
    poiId: index + 1,
    province: "西藏",
    city: "日喀则",
    district: "桑珠孜区",
    address: "很长的地址".repeat(20),
    selectable: index < 30,
    textFields: Array.from({ length: 12 }, (_, field) => ({ path: `tags[${field}].tagId`, value: `${field}` })),
  }));
  const detail = {
    httpStatus: 200,
    businessStatus: "Success",
    poiListCount: 100,
    best: { poiId: 1, poiName: "景点0" },
    candidates,
  };
  const availability = new Map([[1, { status: "available" as const }], [2, { status: "suspended" as const }]]);
  for (let i = 3; i <= 30; i += 1) availability.set(i, { status: "available" });
  const compact = compactPoiQueryResult({ keyword: "帕拉庄园", detail, availability });
  const encoded = JSON.stringify(compact, null, 2);
  assert.ok(encoded.length < 12_000, `expected compact payload, got ${encoded.length}`);
  assert.equal(compact.keyword, "帕拉庄园");
  assert.equal(compact.candidates.length, 20);
  assert.equal(compact.usableDecision.kind, "choose");
  assert.ok(!JSON.stringify(compact).includes("很长的地址"));
  assert.ok(!JSON.stringify(compact).includes("textFields"));
});

test("candidates 上限不超过 20", () => {
  const candidates = Array.from({ length: 40 }, (_, index) => ({
    index,
    poiName: `景点${index}`,
    poiId: index + 1,
    selectable: true,
    textFields: [],
  }));
  const availability = new Map(Array.from({ length: 40 }, (_, index) => [index + 1, { status: "available" as const }]));
  const compact = compactPoiQueryResult({
    keyword: "日喀则",
    detail: { httpStatus: 200, businessStatus: "Success", poiListCount: 40, best: null, candidates },
    availability,
    maxCandidates: 50,
  });
  assert.equal(compact.candidates.length, 20);
});

test("营业状态只核验已确认的 best POI，不扫完整候选列表", () => {
  const candidates = Array.from({ length: 100 }, (_, index) => ({
    index,
    poiName: index === 42 ? "帕拉庄园" : `无关庄园${index}`,
    poiId: index + 1,
    selectable: true,
    textFields: [],
  }));
  const detail = {
    httpStatus: 200,
    businessStatus: "Success",
    poiListCount: 100,
    best: { poiId: 43, poiName: "帕拉庄园" },
    candidates,
  };

  const selected = poiCandidatesForAvailability({ keyword: "帕拉庄园", detail });

  assert.deepEqual(selected.map((item) => item.poiId), [43]);
});

test("未确认目标景点时不把未核验候选当作可用", () => {
  const candidates = Array.from({ length: 40 }, (_, index) => ({
    index,
    poiName: `无关古堡${index}`,
    poiId: index + 1,
    selectable: true,
    textFields: [],
  }));
  const detail = { httpStatus: 200, businessStatus: "Success", poiListCount: 40, best: null, candidates };
  const compact = compactPoiQueryResult({ keyword: "江孜宗山古堡", detail, availability: new Map() });

  assert.equal(compact.usableDecision.kind, "ask");
  assert.equal(compact.candidates[0]?.availabilityStatus, "unchecked");
  assert.match(compact.candidates[0]?.availabilityReason ?? "", /未查营业状态/);
});
