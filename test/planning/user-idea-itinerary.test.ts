import assert from "node:assert/strict";
import test from "node:test";
import { expandVerifiedItinerary } from "../../src/main/planning/planning-v2-pois.js";
import {
  blockingUserPoiFailure,
  parsePlanningUserIntent,
  userPoiCandidateSeeds,
} from "../../src/main/planning/user-intent.js";

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
  assert.deepEqual(intent.activities, [{ id: "user-1", day: 2, title: "翠湖公园", kind: "poi" }]);
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
