import assert from "node:assert/strict";
import test from "node:test";
import { expandVerifiedItinerary } from "../../src/main/planning/planning-v2-pois.js";
import {
  blockingUserPoiFailure,
  hasCompleteDailyUserItinerary,
  parsePlanningUserIntent,
  userPoiCandidateSeeds,
} from "../../src/main/planning/user-intent.js";
import { buildVerifiedPool } from "../../src/main/planning/three-stage-itinerary-flow.js";
import { createPlanningPlanV2 } from "../../src/main/planning/three-stage-orchestrator.js";

test("用户逐日想法解析后生成带日期关联的 POI 候选", () => {
  const intent = parsePlanningUserIntent("第一天布达拉宫，第二天下午做藏香", {
    preferences: ["以藏文化体验为主"],
    activities: [
      { id: "ignored", day: 1, title: "布达拉宫", kind: "poi", time: "上午", detail: null, durationMinutes: null },
      { id: "ignored", day: 2, title: "藏香制作", kind: "activity", time: "下午", detail: "体验藏香制作", durationMinutes: 120 },
    ],
  });
  assert.deepEqual(intent.activities.map((activity) => [activity.id, activity.day, activity.kind]), [
    ["user-1", 1, "poi"],
    ["user-2", 2, "activity"],
  ]);
  assert.deepEqual(userPoiCandidateSeeds(intent), [{
    requestedName: "布达拉宫",
    status: "proposed",
    source: "user",
    userActivityId: "user-1",
    preferredDay: 1,
  }]);
});

test("明确游览景点即使被模型标为 activity 也会纠正为 POI", () => {
  const intent = parsePlanningUserIntent("第二天游览翠湖公园", {
    preferences: [],
    activities: [{ id: "ignored", day: 2, title: "游览翠湖公园", kind: "activity" }],
  });
  assert.deepEqual(intent.activities, [{ id: "user-1", day: 2, title: "翠湖公园", kind: "poi", alternatives: ["翠湖公园"] }]);
  assert.deepEqual(userPoiCandidateSeeds(intent), [{
    requestedName: "翠湖公园", status: "proposed", source: "user", userActivityId: "user-1", preferredDay: 2,
  }]);
});

test("POI 标题去掉游览动词，手作体验不伪装成 POI", () => {
  const intent = parsePlanningUserIntent("第二天游览翠湖公园，第一天下午手作", {
    preferences: [],
    activities: [
      { day: 2, title: "游览翠湖公园", kind: "poi" },
      { day: 1, title: "云上秘境亲子工坊验证点手作体验", kind: "poi" },
    ],
  });
  assert.deepEqual(intent.activities.map((activity) => [activity.title, activity.kind]), [
    ["翠湖公园", "poi"],
    ["云上秘境亲子工坊验证点手作体验", "activity"],
  ]);
});

test("场所加体验或自由活动时仍提取场所 POI，纯手作活动保持普通活动", () => {
  const intent = parsePlanningUserIntent("西安文化体验", {
    preferences: [],
    activities: [
      { day: 1, title: "回坊小吃一条街自由活动", kind: "free" },
      { day: 2, title: "易俗社【皮影制作+秦腔欣赏】", kind: "activity" },
      { day: 2, title: "西影博物馆【刻章+国画+书法体验】", kind: "activity" },
      { day: 3, title: "藏香制作", kind: "activity" },
    ],
  });
  assert.deepEqual(intent.activities.map((activity) => [activity.title, activity.kind]), [
    ["回坊小吃一条街", "poi"],
    ["易俗社", "poi"],
    ["西影博物馆", "poi"],
    ["藏香制作", "activity"],
  ]);
  assert.deepEqual(userPoiCandidateSeeds(intent).map((candidate) => candidate.requestedName), [
    "回坊小吃一条街", "易俗社", "西影博物馆",
  ]);
});

test("用户 POI 二选一拆成独立名称，并保留备选和讲解诉求", () => {
  const intent = parsePlanningUserIntent("D2 日喀则非物质遗产中心或者日喀则博物馆二选一【配讲解】", {
    preferences: [],
    activities: [{
      day: 2,
      title: "日喀则非物质遗产中心或者日喀则博物馆二选一【配讲解】",
      kind: "poi",
      alternatives: [],
      serviceNotes: [],
      time: "下午",
      detail: null,
      durationMinutes: null,
    }],
  });
  assert.deepEqual(intent.activities, [{
    id: "user-1",
    day: 2,
    title: "日喀则非物质遗产中心",
    kind: "poi",
    alternatives: ["日喀则非物质遗产中心", "日喀则博物馆"],
    serviceNotes: ["讲解"],
    time: "下午",
  }]);
  assert.deepEqual(userPoiCandidateSeeds(intent), [{
    requestedName: "日喀则非物质遗产中心",
    status: "proposed",
    source: "user",
    userActivityId: "user-1",
    alternativeNames: ["日喀则非物质遗产中心", "日喀则博物馆"],
    preferredDay: 2,
  }]);
});

test("用户逐日写明活动时跳过 AI 景点推荐，未覆盖日期时仍可推荐", () => {
  const complete = parsePlanningUserIntent("第一天布达拉宫，第二天大昭寺", {
    preferences: [],
    activities: [
      { day: 1, title: "布达拉宫", kind: "poi" },
      { day: 2, title: "大昭寺", kind: "poi" },
    ],
  });
  const incomplete = parsePlanningUserIntent("第一天布达拉宫", {
    preferences: [],
    activities: [{ day: 1, title: "布达拉宫", kind: "poi" }],
  });
  assert.equal(hasCompleteDailyUserItinerary(complete, 2), true);
  assert.equal(hasCompleteDailyUserItinerary(incomplete, 2), false);
  assert.equal(hasCompleteDailyUserItinerary({ rawIdea: "", preferences: [], activities: [] }, 2), false);
});

test("完整用户逐日行程只核验指定 POI，不调用 AI 推荐景点", async () => {
  let plan = {
    ...createPlanningPlanV2(),
    userIntent: parsePlanningUserIntent("第一天布达拉宫，第二天大昭寺", {
      preferences: [],
      activities: [
        { day: 1, title: "布达拉宫", kind: "poi" },
        { day: 2, title: "大昭寺", kind: "poi" },
      ],
    }),
  };
  let recommendationCalls = 0;
  const result = await buildVerifiedPool({
    localProductId: "product-1",
    skeleton: {
      destination: "拉萨",
      province: "西藏",
      city: "拉萨",
      days: 2,
      nights: 1,
      productForm: "privateTour",
      productType: "domesticShort",
      supplierProductCode: "TEST",
    },
    ai: {
      async recommendSpotNames() {
        recommendationCalls += 1;
        return ["不应推荐的景点"];
      },
    } as any,
    runtime: {} as any,
    assertVbkLogin: async () => undefined,
    queryPoi: async (name) => ({
      best: { poiId: name === "布达拉宫" ? 1 : 2, poiName: name },
      candidates: [{ poiId: name === "布达拉宫" ? 1 : 2, poiName: name, province: "西藏", city: "拉萨" }],
    }),
  }, plan, async (id, patch) => {
    plan = { ...plan, nodes: plan.nodes.map((node) => node.id === id ? { ...node, ...patch } : node) };
  }, () => plan, (next) => { plan = next; });
  assert.equal(result.ok, true);
  assert.equal(recommendationCalls, 0);
  assert.equal(plan.nodes.find((node) => node.id === "spotCandidates")?.status, "skipped");
  assert.deepEqual(plan.poiCandidates.map((candidate) => candidate.requestedName), ["布达拉宫", "大昭寺"]);
});

test("二选一首项未命中时按顺序核验后项，不把默认项当成唯一项", async () => {
  let plan = {
    ...createPlanningPlanV2(),
    userIntent: parsePlanningUserIntent("第一天甲景点或者乙景点二选一", {
      preferences: [],
      activities: [{ day: 1, title: "甲景点或者乙景点二选一", kind: "poi" }],
    }),
  };
  const queries: string[] = [];
  const result = await buildVerifiedPool({
    localProductId: "product-2",
    skeleton: {
      destination: "拉萨", province: "西藏", city: "拉萨", days: 1, nights: 0,
      productForm: "privateTour", productType: "domesticShort", supplierProductCode: "TEST",
    },
    ai: {
      async recommendSpotNames() { throw new Error("完整用户行程不应调用景点推荐"); },
      async correctPoiName() { return { terms: ["甲景点别名"], confidence: 0.95, reason: "名称疑似有误" }; },
    } as any,
    runtime: {} as any,
    assertVbkLogin: async () => undefined,
    queryPoi: async (name) => {
      queries.push(name);
      return name === "乙景点"
        ? { best: { poiId: 2, poiName: name }, candidates: [{ poiId: 2, poiName: name, province: "西藏", city: "拉萨" }] }
        : { best: null, candidates: [] };
    },
  }, plan, async (id, patch) => {
    plan = { ...plan, nodes: plan.nodes.map((node) => node.id === id ? { ...node, ...patch } : node) };
  }, () => plan, (next) => { plan = next; });
  assert.equal(result.ok, true);
  assert.deepEqual(queries, ["甲景点", "拉萨甲景点", "甲景点别名", "乙景点"]);
  const selected = plan.poiCandidates[0];
  assert.equal(selected?.status, "resolved");
  assert.equal(selected?.poiId, 2);
  assert.equal(selected?.poiName, "乙景点");
  assert.equal(selected?.selectedAlternativeIndex, 1);
  assert.deepEqual(selected?.alternativeNames, ["甲景点", "乙景点"]);
});

test("二选一多个可用时全部查出并作为同日同段备选入行程", async () => {
  let plan = {
    ...createPlanningPlanV2(),
    userIntent: parsePlanningUserIntent("第一天甲景点或者乙景点二选一", {
      preferences: [], activities: [{ day: 1, title: "甲景点或者乙景点二选一", kind: "poi" }],
    }),
  };
  const queries: string[] = [];
  const result = await buildVerifiedPool({
    localProductId: "product-3",
    skeleton: { destination: "拉萨", province: "西藏", city: "拉萨", days: 1, nights: 0, productForm: "privateTour", productType: "domesticShort", supplierProductCode: "TEST" },
    ai: { async recommendSpotNames() { throw new Error("完整用户行程不应调用景点推荐"); } } as any,
    runtime: {} as any, assertVbkLogin: async () => undefined,
    queryPoi: async (name) => {
      queries.push(name);
      const poiId = name === "甲景点" ? 1 : 2;
      return { best: { poiId, poiName: name }, candidates: [{ poiId, poiName: name, province: "西藏", city: "拉萨" }] };
    },
  }, plan, async (id, patch) => {
    plan = { ...plan, nodes: plan.nodes.map((node) => node.id === id ? { ...node, ...patch } : node) };
  }, () => plan, (next) => { plan = next; });
  assert.equal(result.ok, true);
  assert.deepEqual(queries, ["甲景点", "乙景点"]);
  assert.deepEqual(plan.poiCandidates.map((candidate) => ({
    requestedName: candidate.requestedName,
    status: candidate.status,
    poiName: candidate.poiName,
    poiId: candidate.poiId,
    userActivityId: candidate.userActivityId,
    selectedAlternativeIndex: candidate.selectedAlternativeIndex,
  })), [
    {
      requestedName: "甲景点",
      status: "resolved",
      poiName: "甲景点",
      poiId: 1,
      userActivityId: "user-1",
      selectedAlternativeIndex: 0,
    },
    {
      requestedName: "乙景点",
      status: "resolved",
      poiName: "乙景点",
      poiId: 2,
      userActivityId: "user-1",
      selectedAlternativeIndex: 1,
    },
  ]);
  const expanded = expandVerifiedItinerary({
    days: 1,
    userIntent: plan.userIntent,
    pool: plan.poiCandidates,
    drafts: [{ day: 1, title: "备选游览", description: "游览备选点", poiIds: [1, 2], meals: "午餐自理", mealDescriptions: ["", "午餐自理", ""] }],
  });
  assert.equal(expanded.ok, true);
  if (!expanded.ok) return;
  assert.match(String(expanded.itinerary[0].description), /甲景点或乙景点/);
  assert.deepEqual((expanded.itinerary[0].spots as Array<{ timeOfDay: string; relation: string }>).map((spot) => spot.timeOfDay), ["morning", "morning"]);
  assert.deepEqual((expanded.itinerary[0].spots as Array<{ relation: string }>).map((spot) => spot.relation), ["or", "or"]);
  const split = expandVerifiedItinerary({
    days: 1,
    userIntent: plan.userIntent,
    pool: [
      ...plan.poiCandidates,
      { requestedName: "丙景点", status: "resolved", source: "user", userActivityId: "user-2", preferredDay: 1, poiId: 3, poiName: "丙景点", province: "西藏", city: "拉萨" },
    ],
    drafts: [{ day: 1, title: "备选游览", description: "游览备选点", poiIds: [1, 3, 2], meals: "午餐自理", mealDescriptions: ["", "午餐自理", ""] }],
  });
  assert.equal(split.ok, false);
  if (!split.ok) assert.match(split.reason, /必须连续放在同一段行程/);
});

test("未命中 POI 的用户活动保留在原日期并落为 other", () => {
  const intent = parsePlanningUserIntent("第一天参观非遗工坊", {
    preferences: [],
    activities: [{ id: "x", day: 1, title: "非遗工坊", kind: "poi", time: "下午", detail: "体验手作", durationMinutes: 90 }],
  });
  const pool = [{
    requestedName: "非遗工坊",
    status: "rejected" as const,
    source: "user" as const,
    userActivityId: "user-1",
    preferredDay: 1,
    reason: "未命中可确认的真实 POI",
  }];
  const expanded = expandVerifiedItinerary({
    days: 1,
    userIntent: intent,
    pool,
    drafts: [{ day: 1, title: "非遗体验", description: "按用户安排体验手作", poiIds: [], meals: "三餐自理" }],
  });
  assert.equal(expanded.ok, true);
  if (!expanded.ok) return;
  assert.deepEqual(expanded.itinerary[0].spots, []);
  assert.deepEqual(expanded.itinerary[0].activities, [{
    time: "下午",
    title: "非遗工坊",
    detail: "体验手作",
    type: "other",
    durationMinutes: 90,
    source: "user",
  }]);
});

test("已匹配的用户同义 POI 不再重复写入 other", () => {
  const intent = {
    rawIdea: "第一天游览翠湖公园",
    preferences: [],
    activities: [{
      id: "user-1", day: 1, title: "游览翠湖公园", kind: "activity" as const,
      time: "全天", detail: "游览翠湖公园", durationMinutes: 120,
    }],
  };
  const expanded = expandVerifiedItinerary({
    days: 1,
    userIntent: intent,
    pool: [{
      requestedName: "翠湖公园", status: "resolved", source: "ai",
      poiId: 78617, poiName: "翠湖公园", city: "昆明",
    }],
    drafts: [
      { day: 1, title: "翠湖公园", description: "翠湖公园游览", poiIds: [78617], meals: "三餐自理" },
    ],
  });
  assert.equal(expanded.ok, true);
  if (!expanded.ok) return;
  assert.equal(expanded.itinerary[0].activities, undefined);
});

test("用户指定日期的已验证 POI 不可挪日或省略", () => {
  const intent = parsePlanningUserIntent("第二天布达拉宫", {
    preferences: [],
    activities: [{ id: "x", day: 2, title: "布达拉宫", kind: "poi", time: null, detail: null, durationMinutes: null }],
  });
  const pool = [{
    requestedName: "布达拉宫", status: "resolved" as const, source: "user" as const,
    userActivityId: "user-1", preferredDay: 2, poiId: 100, poiName: "布达拉宫", city: "拉萨",
  }];
  const moved = expandVerifiedItinerary({
    days: 2, userIntent: intent, pool,
    drafts: [
      { day: 1, title: "错误日期", description: "错误安排", poiIds: [100], meals: "三餐自理" },
      { day: 2, title: "自由活动", description: "休息", poiIds: [], meals: "三餐自理" },
    ],
  });
  assert.equal(moved.ok, false);
  if (!moved.ok) assert.match(moved.reason, /必须保留在第 2 天/);
});

test("用户 POI 地域不匹配不能伪装成 other", () => {
  assert.match(blockingUserPoiFailure([{
    requestedName: "外地景点", status: "rejected", source: "user",
    reason: "POI 地域不匹配（四川/成都）",
  }]) ?? "", /不能作为本次行程活动/);
});

test("用户指定到某一天的 POI 未命中时不能静默降级为 other", () => {
  assert.match(blockingUserPoiFailure([{
    requestedName: "天安门", status: "rejected", source: "user",
    preferredDay: 1, reason: "未命中可确认的真实 POI",
  }]) ?? "", /不能作为本次行程活动/);
});
