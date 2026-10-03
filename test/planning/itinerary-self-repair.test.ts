import assert from "node:assert/strict";
import test from "node:test";
import { selfRepairItineraryForVbk } from "../../src/main/planning/itinerary-self-repair.js";

test("末日明确不住宿才清理误填酒店，保留真实住宿与普通待核验 POI", () => {
  const original = [
    { day: 1, hotel: "酒店", spots: [{ name: "景点" }] },
    { day: 2, hotel: "酒店", spots: [{ name: "景点" }] },
    { day: 3, hotel: "酒店", hotelDescription: "送火车日不实际安排住宿", hotelCandidates: [{ hotelId: 1 }], spots: [{ name: "景点" }] },
  ];
  const result = selfRepairItineraryForVbk(original, 2);
  assert.equal(result.itinerary[0].hotel, "酒店");
  assert.equal(result.itinerary[2].hotel, "无");
  assert.equal(result.itinerary[2].hotelCandidates, undefined);
  assert.equal(original[2].hotel, "酒店");
  assert.equal(selfRepairItineraryForVbk(original, 3).itinerary[2].hotel, "酒店");
  original[2].hotelDescription = "入住酒店";
  assert.equal(selfRepairItineraryForVbk(original, 2).itinerary[2].hotel, "酒店");
});

test("交通和入住节点移出 POI 列表，已核验二选一自动收敛", () => {
  const result = selfRepairItineraryForVbk([
    {
      day: 1,
      title: "接站游览后入住",
      description: "日喀则站接站，游览后入住酒店。",
      meals: "自理",
      spots: [
        { name: "日喀则火车站", relation: "and" },
        { name: "帕拉庄园", poiName: "帕拉庄园", poiId: 85093, relation: "and" },
        { name: "日喀则（入住）", relation: "and" },
      ],
    },
    {
      day: 2,
      title: "人文二选一",
      description: "非遗中心或博物馆二选一。",
      meals: "自理",
      spots: [
        { name: "日喀则非物质遗产中心", poiName: null, poiId: null, timeOfDay: "morning", relation: "or" },
        { name: "日喀则博物馆", poiName: "日喀则博物馆", poiId: 79437758, timeOfDay: "morning", relation: "or" },
        { name: "扎什伦布寺", poiName: "扎什伦布寺", poiId: 76348, timeOfDay: "afternoon", relation: "and" },
        { name: "日喀则火车站", relation: "and" },
      ],
    },
  ]);

  assert.equal(result.changed, true);
  assert.deepEqual(result.removedTravelNodes, ["日喀则火车站", "日喀则（入住）", "日喀则火车站"]);
  assert.deepEqual(result.selectedAlternatives, [{
    day: 2,
    kept: ["日喀则博物馆"],
    removed: ["日喀则非物质遗产中心"],
  }]);
  assert.deepEqual(result.itinerary.map((day) => (day.spots as Array<{ name: string }>).map((spot) => spot.name)), [
    ["帕拉庄园"],
    ["日喀则博物馆", "扎什伦布寺"],
  ]);
  assert.equal(((result.itinerary[1]!.spots as Array<Record<string, unknown>>)[0]!.relation), "and");
});

test("普通未命中景点和全部未命中的二选一保持不动", () => {
  const itinerary = [{
    day: 1,
    title: "待核验",
    description: "待核验",
    meals: "自理",
    spots: [
      { name: "景点A", poiName: null, poiId: null, timeOfDay: "morning", relation: "or" },
      { name: "景点B", poiName: null, poiId: null, timeOfDay: "morning", relation: "or" },
      { name: "景点C", poiName: null, poiId: null, timeOfDay: "afternoon", relation: "and" },
    ],
  }];
  const result = selfRepairItineraryForVbk(itinerary);
  assert.equal(result.changed, false);
  assert.deepEqual(result.itinerary, itinerary);
  assert.deepEqual(result.selectedAlternatives, []);
});

test("明确 other/free 即使遗留 relation=or 也保留且不跨景点二选一分组", () => {
  const result = selfRepairItineraryForVbk([{ day: 1, spots: [
    { name: "景点甲", poiName: null, poiId: null, relation: "or", timeOfDay: "morning" },
    { name: "接机", kind: "other", relation: "or", timeOfDay: "morning" },
    { name: "景点乙", poiName: "景点乙", poiId: 2, relation: "or", timeOfDay: "morning" },
    { name: "自由活动", kind: "free", relation: "or", timeOfDay: "afternoon" },
  ] }]);
  const spots = result.itinerary[0].spots as Array<Record<string, unknown>>;
  assert.deepEqual(spots.map((spot) => spot.name), ["景点甲", "接机", "景点乙", "自由活动"]);
  assert.equal(spots[1].relation, "and");
  assert.equal(spots[3].relation, "and");
});
