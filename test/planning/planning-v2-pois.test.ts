import assert from "node:assert/strict";
import test from "node:test";
import {
  expandVerifiedItinerary,
  resolvePlanningPoiCandidates,
  toPlanningCandidate,
} from "../../src/main/planning/planning-v2-pois.js";
import type { PoiSuggestDetailResult } from "../../src/shared/contracts.js";

function detail(args: { requested: string; poiName?: string; poiId?: number; province?: string; city?: string; district?: string; address?: string; textFields?: Array<{ path: string; value: string }> }): PoiSuggestDetailResult {
  const poiName = args.poiName ?? args.requested;
  const poiId = args.poiId ?? 101;
  return {
    httpStatus: 200,
    businessStatus: "Success",
    poiListCount: 1,
    best: { poiName, poiId },
    candidates: [{
      index: 0,
      poiName,
      poiId,
      selectable: true,
      textFields: args.textFields ?? [
        { path: "districtInfo.provinceName", value: args.province ?? "西藏" },
        { path: "districtInfo.cityName", value: args.city ?? "拉萨" },
        { path: "districtInfo.districtName", value: args.district ?? "城关区" },
        { path: "address", value: args.address ?? "北京中路" },
      ],
    }],
  };
}

test("真实 district parents 英文行政区字段可解析同城 POI，异地和未知地域仍拒绝", () => {
  const xiAn = toPlanningCandidate("西安城墙", detail({
    requested: "西安城墙",
    textFields: [
      { path: "district.districtName", value: "Yanta District" },
      { path: "district.districtType", value: "District" },
      { path: "district.parents[0].districtName", value: "Xi'an" },
      { path: "district.parents[0].districtType", value: "City" },
      { path: "district.parents[1].districtName", value: "Shaanxi" },
      { path: "district.parents[1].districtType", value: "Province" },
      { path: "address", value: "South Gate" },
    ],
  }), "陕西", "西安");
  assert.equal(xiAn.status, "resolved");
  assert.equal(xiAn.city, "Xi'an");
  assert.equal(xiAn.province, "Shaanxi");
  assert.equal(xiAn.district, "Yanta District");

  const otherCity = toPlanningCandidate("成都景点", detail({
    requested: "成都景点",
    textFields: [
      { path: "district.districtName", value: "Wuhou District" },
      { path: "district.districtType", value: "District" },
      { path: "district.parents[0].districtName", value: "Chengdu" },
      { path: "district.parents[0].districtType", value: "City" },
      { path: "district.parents[1].districtName", value: "Sichuan" },
      { path: "district.parents[1].districtType", value: "Province" },
    ],
  }), "陕西", "西安");
  assert.equal(otherCity.status, "rejected");
  assert.match(otherCity.reason ?? "", /地域不匹配/);

  const unknown = toPlanningCandidate("未知景点", detail({
    requested: "未知景点",
    textFields: [{ path: "address", value: "Somewhere" }],
  }), "陕西", "西安");
  assert.equal(unknown.status, "rejected");
  assert.match(unknown.reason ?? "", /地域未知/);
});

test("Gyantse(City)+Shigatse(City)+Tibet 结构化字段可匹配日喀则产品", () => {
  // 真实白居寺 district：当前节点 City=Gyantse，上级 City=Shigatse，Province=Tibet。
  const detailResult: PoiSuggestDetailResult = {
    httpStatus: 200,
    businessStatus: "Success",
    poiListCount: 1,
    best: { poiName: "白居寺", poiId: 76349 },
    candidates: [{
      index: 0,
      poiName: "白居寺",
      poiId: 76349,
      selectable: true,
      province: "Tibet",
      city: "Shigatse",
      district: "Gyantse",
      address: "Gyantse",
      textFields: [
        { path: "district.districtName", value: "Gyantse" },
        { path: "district.districtType", value: "City" },
        { path: "district.parents[0].districtName", value: "Shigatse" },
        { path: "district.parents[0].districtType", value: "City" },
        { path: "district.parents[1].districtName", value: "Tibet" },
        { path: "district.parents[1].districtType", value: "Province" },
      ],
    }],
  };
  const resolved = toPlanningCandidate("白居寺", detailResult, "西藏", "日喀则");
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.city, "Shigatse");
  assert.equal(resolved.province, "Tibet");
  assert.equal(resolved.district, "Gyantse");
});

test("POI candidate keeps official identity and rejects foreign/facility matches", () => {
  const valid = toPlanningCandidate("布达拉宫", detail({ requested: "布达拉宫" }), "西藏", "拉萨");
  assert.equal(valid.status, "resolved");
  assert.equal(valid.poiId, 101);
  assert.equal(valid.city, "拉萨");
  assert.equal(valid.address, "北京中路");

  const foreign = toPlanningCandidate("南山", detail({ requested: "南山", province: "广东", city: "深圳" }), "西藏", "拉萨");
  assert.equal(foreign.status, "rejected");
  assert.match(foreign.reason ?? "", /地域不匹配/);

  const facility = toPlanningCandidate("布达拉宫入口", detail({ requested: "布达拉宫入口" }), "西藏", "拉萨");
  assert.equal(facility.status, "rejected");
  assert.match(facility.reason ?? "", /入口/);
});

test("POI queries are bounded at five concurrent requests", async () => {
  let active = 0;
  let peak = 0;
  const names = Array.from({ length: 16 }, (_, index) => `景点${index}`);
  const resolved = await resolvePlanningPoiCandidates({
    names,
    province: "西藏",
    city: "拉萨",
    concurrency: 5,
    beforeEach: async () => undefined,
    query: async (name) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return detail({ requested: name, poiId: Number(name.replace("景点", "")) + 1 });
    },
  });
  assert.equal(resolved.length, names.length);
  assert.equal(peak, 5);
});

test("异地同名 POI 会以产品城市重查，命中同城结果后继续一键规划", async () => {
  const queries: string[] = [];
  const [candidate] = await resolvePlanningPoiCandidates({
    names: ["长城"],
    province: "北京",
    city: "北京",
    beforeEach: async () => undefined,
    query: async (name) => {
      queries.push(name);
      return name === "北京长城"
        ? detail({ requested: name, poiName: "八达岭长城", poiId: 88001, province: "北京", city: "北京" })
        : detail({ requested: name, poiName: "长城", poiId: 88000, province: "河北", city: "张家口" });
    },
  });

  assert.deepEqual(queries, ["长城", "北京长城"]);
  assert.deepEqual(candidate, {
    requestedName: "长城",
    status: "resolved",
    poiId: 88001,
    poiName: "八达岭长城",
    province: "北京",
    city: "北京",
    district: "城关区",
    address: "北京中路",
  });
});

test("用户简称未精确命中时，AI 只从同城真实候选中选择大众常游主景点", async () => {
  const queries: string[] = [];
  const ambiguous: PoiSuggestDetailResult = {
    httpStatus: 200,
    businessStatus: "Success",
    poiListCount: 3,
    best: null,
    candidates: [
      { index: 0, poiName: "天安门广场", poiId: 75594, selectable: true, province: "北京", city: "北京", district: "东城区", address: "东长安街", textFields: [] },
      { index: 1, poiName: "天安门城楼", poiId: 84616, selectable: true, province: "北京", city: "北京", district: "东城区", address: "西长安街", textFields: [] },
      { index: 2, poiName: "同安影视城-天安门", poiId: 143751554, selectable: true, province: "福建", city: "厦门", textFields: [] },
    ],
  };
  const [candidate] = await resolvePlanningPoiCandidates({
    names: ["天安门"], province: "北京", city: "北京", destination: "北京",
    userIdea: "第一天天安门、故宫", beforeEach: async () => undefined,
    query: async (name) => { queries.push(name); return ambiguous; },
    shouldDisambiguate: () => true,
    preferredDay: () => 1,
    disambiguate: async (request) => {
      assert.deepEqual(request.candidates.map((item) => item.poiName), ["天安门广场", "天安门城楼"]);
      assert.equal("poiId" in request.candidates[0], false, "AI 请求不能包含真实 POI ID");
      assert.equal(request.preferredDay, 1);
      return { decision: "selected", candidateId: "candidate-1", confidence: 0.93, reason: "大众常游主景点" };
    },
  });
  assert.deepEqual(queries, ["天安门", "北京天安门"]);
  assert.equal(candidate.status, "resolved");
  assert.equal(candidate.poiName, "天安门广场");
  assert.equal(candidate.poiId, 75594);
  assert.match(candidate.reason ?? "", /AI 消歧/);
});

test("城市重查命中内部子景点时仍由 AI 选择大众常游主景点", async () => {
  const direct: PoiSuggestDetailResult = {
    httpStatus: 200,
    businessStatus: "Success",
    poiListCount: 3,
    best: { poiName: "长城", poiId: 99000 },
    candidates: [
      { index: 0, poiName: "长城", poiId: 99000, selectable: true, province: "河北", city: "张家口", textFields: [] },
      { index: 1, poiName: "八达岭长城", poiId: 75596, selectable: true, province: "北京", city: "北京", textFields: [] },
      { index: 2, poiName: "慕田峪长城", poiId: 75609, selectable: true, province: "北京", city: "北京", textFields: [] },
    ],
  };
  const cityQualified: PoiSuggestDetailResult = {
    httpStatus: 200,
    businessStatus: "Success",
    poiListCount: 3,
    best: { poiName: "北京青龙峡风景区-古长城", poiId: 149947398 },
    candidates: [
      { index: 0, poiName: "北京青龙峡风景区-古长城", poiId: 149947398, selectable: true, province: "北京", city: "北京", textFields: [] },
      { index: 1, poiName: "八达岭长城", poiId: 75596, selectable: true, province: "北京", city: "北京", textFields: [] },
      { index: 2, poiName: "慕田峪长城", poiId: 75609, selectable: true, province: "北京", city: "北京", textFields: [] },
    ],
  };
  let aiCalls = 0;
  const [candidate] = await resolvePlanningPoiCandidates({
    names: ["长城"], province: "北京", city: "北京", destination: "北京", beforeEach: async () => undefined,
    query: async (name) => name === "北京长城" ? cityQualified : direct,
    shouldDisambiguate: () => true,
    disambiguate: async (request) => {
      aiCalls += 1;
      assert.deepEqual(
        request.candidates.map((item) => item.poiName),
        ["八达岭长城", "慕田峪长城", "北京青龙峡风景区-古长城"],
      );
      return { decision: "selected", candidateId: "candidate-1", confidence: 0.95, reason: "普通游客最常前往的代表性主景点" };
    },
  });

  assert.equal(aiCalls, 1);
  assert.equal(candidate.status, "resolved");
  assert.equal(candidate.poiName, "八达岭长城");
  assert.equal(candidate.poiId, 75596);
  assert.notEqual(candidate.poiId, 149947398);
});

test("AI 无法确定简称时保留候选摘要并进入人工确认", async () => {
  const ambiguous: PoiSuggestDetailResult = {
    httpStatus: 200, businessStatus: "Success", poiListCount: 2, best: null,
    candidates: [
      { index: 0, poiName: "八达岭长城", poiId: 75596, selectable: true, province: "北京", city: "北京", textFields: [] },
      { index: 1, poiName: "慕田峪长城", poiId: 75609, selectable: true, province: "北京", city: "北京", textFields: [] },
    ],
  };
  const [candidate] = await resolvePlanningPoiCandidates({
    names: ["长城"], province: "北京", city: "北京", beforeEach: async () => undefined,
    query: async () => ambiguous, shouldDisambiguate: () => true,
    disambiguate: async () => ({ decision: "uncertain", confidence: 0.55, reason: "缺少具体偏好" }),
  });
  assert.equal(candidate.status, "rejected");
  assert.match(candidate.reason ?? "", /八达岭长城、慕田峪长城/);
  assert.match(candidate.reason ?? "", /缺少具体偏好/);
});

test("用户明确指定官方主景点时不调用 AI 消歧", async () => {
  let calls = 0;
  const [candidate] = await resolvePlanningPoiCandidates({
    names: ["慕田峪长城"], province: "北京", city: "北京", beforeEach: async () => undefined,
    query: async (name) => detail({ requested: name, poiId: 75609, province: "北京", city: "北京" }),
    shouldDisambiguate: () => true,
    disambiguate: async () => { calls += 1; return { decision: "uncertain", confidence: 0, reason: "不应调用" }; },
  });
  assert.equal(candidate.status, "resolved");
  assert.equal(candidate.poiId, 75609);
  assert.equal(calls, 0);
});

test("AI 选中的真实候选仍必须通过暂停营业检查", async () => {
  const ambiguous: PoiSuggestDetailResult = {
    httpStatus: 200, businessStatus: "Success", poiListCount: 1, best: null,
    candidates: [{ index: 0, poiName: "天安门广场", poiId: 75594, selectable: true, province: "北京", city: "北京", textFields: [] }],
  };
  const [candidate] = await resolvePlanningPoiCandidates({
    names: ["天安门"], province: "北京", city: "北京", beforeEach: async () => undefined,
    query: async () => ambiguous, shouldDisambiguate: () => true,
    disambiguate: async () => ({ decision: "selected", candidateId: "candidate-1", confidence: 0.96, reason: "代表性主景点" }),
    checkAvailability: async () => ({ status: "suspended" }),
  });
  assert.equal(candidate.status, "rejected");
  assert.match(candidate.reason ?? "", /暂停营业/);
});

test("three-stage POI pool rejects suspended sights immediately after resolving their ID", async () => {
  const events: string[] = [];
  const [candidate] = await resolvePlanningPoiCandidates({
    names: ["金沙遗址博物馆"],
    province: "四川",
    city: "成都",
    concurrency: 5,
    beforeEach: async () => undefined,
    query: async (name) => {
      events.push(`id:${name}`);
      return detail({ requested: name, poiId: 82723, province: "四川", city: "成都" });
    },
    checkAvailability: async (poiId) => {
      events.push(`availability:${poiId}`);
      return { status: "suspended" };
    },
  });

  assert.deepEqual(events, ["id:金沙遗址博物馆", "availability:82723"]);
  assert.deepEqual(candidate, {
    requestedName: "金沙遗址博物馆",
    status: "rejected",
    poiId: 82723,
    poiName: "金沙遗址博物馆",
    reason: "携程景点详情标记为暂停营业",
  });
});

test("itinerary only accepts pool POIs, repairs safe duplicates, and rejects A-B-A", () => {
  const pool = [
    { requestedName: "A1", status: "resolved" as const, poiId: 1, poiName: "A1", city: "拉萨" },
    { requestedName: "B1", status: "resolved" as const, poiId: 2, poiName: "B1", city: "日喀则" },
    { requestedName: "A2", status: "resolved" as const, poiId: 3, poiName: "A2", city: "拉萨" },
  ];
  const base = (poiIds: number[][]) => poiIds.map((ids, index) => ({
    day: index + 1,
    title: `第${index + 1}天`,
    description: "合理游览",
    poiIds: ids,
    meals: "早餐自理；午餐自理；晚餐自理",
  }));
  assert.equal(expandVerifiedItinerary({ drafts: base([[1], [2]]), pool, days: 2 }).ok, true);
  const duplicate = expandVerifiedItinerary({ drafts: base([[1], [1]]), pool, days: 2 });
  assert.equal(duplicate.ok, true);
  if (duplicate.ok) {
    const ids = duplicate.itinerary.flatMap((day) => (day.spots as Array<{ poiId: number }>).map((spot) => spot.poiId));
    assert.equal(new Set(ids).size, 2);
    assert.equal(ids[0], 1);
    assert.notEqual(ids[1], 1);
  }
  const outside = expandVerifiedItinerary({ drafts: base([[99], [2]]), pool, days: 2 });
  assert.equal(outside.ok, false);
  if (!outside.ok) assert.match(outside.reason, /候选池外/);
  const backtrack = expandVerifiedItinerary({ drafts: base([[1], [2], [3]]), pool, days: 3 });
  assert.equal(backtrack.ok, false);
  if (!backtrack.ok) assert.match(backtrack.reason, /折返/);
});

test("多日规划的空白日只用未占用的已核验 POI 确定性补位", () => {
  const pool = Array.from({ length: 7 }, (_, index) => ({
    requestedName: `西安景点${index + 1}`,
    status: "resolved" as const,
    source: "ai" as const,
    poiId: index + 1,
    poiName: `西安景点${index + 1}`,
    city: "西安",
  }));
  const drafts = Array.from({ length: 7 }, (_, index) => ({
    day: index + 1,
    title: index === 5 ? "" : `第${index + 1}天`,
    description: index === 5 ? "" : "合理游览",
    poiIds: index === 5 ? [] : [index + 1],
    meals: "三餐自理",
  }));

  const expanded = expandVerifiedItinerary({ drafts, pool, days: 7 });

  assert.equal(expanded.ok, true);
  if (!expanded.ok) return;
  const sixth = expanded.itinerary[5] as { title: string; description: string; spots: Array<{ poiId: number }> };
  assert.equal(sixth.spots[0].poiId, 6);
  assert.match(sixth.title, /西安景点6/);
  assert.match(sixth.description, /西安景点6/);
  assert.equal(new Set(expanded.itinerary.flatMap((day) =>
    (day.spots as Array<{ poiId: number }>).map((spot) => spot.poiId))).size, 7);
});

test("逐日用户 POI 已匹配时，编排不能擅自增加或遗漏当天景点", () => {
  const pool = [
    { requestedName: "故宫", status: "resolved" as const, source: "user" as const, preferredDay: 1, poiId: 75595, poiName: "故宫博物院", city: "北京" },
    { requestedName: "景山", status: "resolved" as const, source: "ai" as const, poiId: 76610, poiName: "景山公园", city: "北京" },
  ];
  const expanded = expandVerifiedItinerary({
    days: 1,
    pool,
    userIntent: { rawIdea: "第一天故宫", preferences: [], activities: [] },
    drafts: [{ day: 1, title: "北京中轴", description: "游览故宫与景山", poiIds: [75595, 76610] }],
  });
  assert.equal(expanded.ok, false);
  if (!expanded.ok) assert.match(expanded.reason, /用户未指定/);
});
