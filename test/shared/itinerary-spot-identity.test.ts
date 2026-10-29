import assert from "node:assert/strict";
import test from "node:test";
import {
  ensureItinerarySpotIds,
  findItinerarySpot,
  inheritItinerarySpotIds,
  isItinerarySpotId,
  itinerarySpotKey,
  newItinerarySpotId,
} from "../../src/shared/itinerary-spot-identity.js";

type Spot = Record<string, unknown>;
const ID1 = "sp_000000000001";
const ID2 = "sp_000000000002";

function product(...days: Array<{ day: number; spots: Array<Spot | string> }>): Record<string, unknown> {
  return { itinerary: days };
}

function ids(result: Record<string, unknown>, dayIndex = 0): unknown[] {
  const days = result.itinerary as Array<{ spots: Spot[] }>;
  return days[dayIndex].spots.map((spot) => spot.spotId);
}

test("newItinerarySpotId 与 isItinerarySpotId 格式一致", () => {
  const id = newItinerarySpotId();
  assert.match(id, /^sp_[0-9a-f]{12}$/);
  assert.equal(isItinerarySpotId(id), true);
  assert.equal(isItinerarySpotId("sp_XYZ"), false);
  assert.equal(isItinerarySpotId(undefined), false);
  assert.notEqual(newItinerarySpotId(), newItinerarySpotId());
});

test("itinerarySpotKey 与 poiNameKey 等价", () => {
  assert.equal(itinerarySpotKey("广济桥（不上桥）"), "广济桥");
  assert.equal(itinerarySpotKey(null), "");
});

test("继承：同天同名一对一", () => {
  const prev = product({ day: 1, spots: [{ name: "A", spotId: ID1 }, { name: "A", spotId: ID2 }] });
  const next = product({ day: 1, spots: [{ name: "A" }, { name: "A" }] });
  assert.deepEqual(ids(inheritItinerarySpotIds(prev, next)), [ID1, ID2]);
});

test("继承：重排后 ID 跟名字", () => {
  const prev = product({ day: 1, spots: [{ name: "A", spotId: ID1 }, { name: "B", spotId: ID2 }] });
  const next = product({ day: 1, spots: [{ name: "B" }, { name: "A" }] });
  assert.deepEqual(ids(inheritItinerarySpotIds(prev, next)), [ID2, ID1]);
});

test("继承：名称键等价", () => {
  const prev = product({ day: 1, spots: [{ name: "广济桥（不上桥）", spotId: ID1 }] });
  const next = product({ day: 1, spots: [{ name: "广济桥" }] });
  assert.deepEqual(ids(inheritItinerarySpotIds(prev, next)), [ID1]);
});

test("继承：不跨天按名", () => {
  const prev = product({ day: 1, spots: [{ name: "A", spotId: ID1 }] });
  const next = product({ day: 2, spots: [{ name: "A" }] });
  const [id] = ids(inheritItinerarySpotIds(prev, next), 0);
  assert.equal(isItinerarySpotId(id), true);
  assert.notEqual(id, ID1);
});

test("继承：显式 ID 可跨天", () => {
  const prev = product({ day: 1, spots: [{ name: "A", spotId: ID1 }] });
  const next = product({ day: 2, spots: [{ name: "A", spotId: ID1 }] });
  assert.deepEqual(ids(inheritItinerarySpotIds(prev, next)), [ID1]);
});

test("继承：显式 ID 不被前面的同名景点抢走", () => {
  const prev = product({ day: 1, spots: [{ name: "A", spotId: ID1 }] });
  const next = product({ day: 1, spots: [{ name: "A" }, { name: "A", spotId: ID1 }] });
  const result = ids(inheritItinerarySpotIds(prev, next));
  assert.equal(result[1], ID1);
  assert.notEqual(result[0], ID1);
  assert.equal(isItinerarySpotId(result[0]), true);
});

test("继承：按 poiId 兜底", () => {
  const prev = product({ day: 1, spots: [{ name: "古汉台", poiId: 9, spotId: ID1 }] });
  const next = product({ day: 1, spots: [{ name: "汉中市古汉台博物馆", poiId: 9 }] });
  assert.deepEqual(ids(inheritItinerarySpotIds(prev, next)), [ID1]);
});

test("继承：新方案内重复显式 ID 从第二次起换新，且不改入参", () => {
  const prev = product({ day: 1, spots: [{ name: "A", spotId: ID1 }] });
  const next = product({ day: 1, spots: [{ name: "A", spotId: ID1 }, { name: "B", spotId: ID1 }] });
  const snapshot = JSON.stringify([prev, next]);
  const result = ids(inheritItinerarySpotIds(prev, next));
  assert.equal(result[0], ID1);
  assert.notEqual(result[1], ID1);
  assert.equal(isItinerarySpotId(result[1]), true);
  assert.equal(JSON.stringify([prev, next]), snapshot);
});

test("继承：字符串 spot 原样保留，按 day 编号而非下标匹配天", () => {
  const prev = product({ day: 2, spots: [{ name: "A", spotId: ID1 }] });
  const next = product({ day: 1, spots: ["自由活动"] }, { day: 2, spots: [{ name: "A" }] });
  const result = inheritItinerarySpotIds(prev, next);
  const days = result.itinerary as Array<{ spots: unknown[] }>;
  assert.equal(days[0].spots[0], "自由活动");
  assert.deepEqual(ids(result, 1), [ID1]);
});

test("补齐：重复 ID 第二个换新", () => {
  const input = product({ day: 1, spots: [{ name: "A", spotId: ID1 }, { name: "B", spotId: ID1 }, { name: "C" }] });
  const result = ensureItinerarySpotIds(input);
  const out = ids(result);
  assert.equal(out[0], ID1);
  assert.notEqual(out[1], ID1);
  assert.equal(isItinerarySpotId(out[1]), true);
  assert.equal(isItinerarySpotId(out[2]), true);
});

test("补齐：无变化返回同一引用", () => {
  const input = product({ day: 1, spots: [{ name: "A", spotId: ID1 }, "自由活动"] });
  assert.equal(ensureItinerarySpotIds(input), input);
});

test("findItinerarySpot 返回下标与景点", () => {
  const input = product({ day: 1, spots: [{ name: "A", spotId: ID1 }] }, { day: 2, spots: [{ name: "B", spotId: ID2 }] });
  const hit = findItinerarySpot(input, ID2);
  assert.equal(hit?.dayIndex, 1);
  assert.equal(hit?.spotIndex, 0);
  assert.equal(hit?.spot.name, "B");
  assert.equal(findItinerarySpot(input, "sp_ffffffffffff"), undefined);
});

test("继承：同天「X」与「X（注释）」并存时重排，先按原名一对一，不按名称键串号", () => {
  const prev = product({ day: 1, spots: [{ name: "平遥古城", spotId: ID1, poiId: 9 }, { name: "平遥古城（夜景）", spotId: ID2 }] });
  const next = product({ day: 1, spots: [{ name: "平遥古城（夜景）" }, { name: "平遥古城" }] });
  assert.deepEqual(ids(inheritItinerarySpotIds(prev, next)), [ID2, ID1]);
});

test("继承：名称轮次全部做完才按 poiId 兜底，前面的 poiId 命中不抢后面的同名", () => {
  const prev = product({ day: 1, spots: [{ name: "古汉台", spotId: ID1, poiId: 9 }] });
  const next = product({ day: 1, spots: [{ name: "汉中市古汉台博物馆", poiId: 9 }, { name: "古汉台", poiId: 9 }] });
  const result = ids(inheritItinerarySpotIds(prev, next));
  assert.equal(result[1], ID1);
  assert.notEqual(result[0], ID1);
});
