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

test("itinerary only accepts pool POIs, exact day coverage, no duplicates or A-B-A", () => {
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
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.match(duplicate.reason, /重复/);
  const outside = expandVerifiedItinerary({ drafts: base([[99], [2]]), pool, days: 2 });
  assert.equal(outside.ok, false);
  if (!outside.ok) assert.match(outside.reason, /候选池外/);
  const backtrack = expandVerifiedItinerary({ drafts: base([[1], [2], [3]]), pool, days: 3 });
  assert.equal(backtrack.ok, false);
  if (!backtrack.ok) assert.match(backtrack.reason, /折返/);
});
