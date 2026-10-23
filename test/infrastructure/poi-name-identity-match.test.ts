import assert from "node:assert/strict";
import test from "node:test";
import { pickBestPoi } from "../../src/main/infrastructure/poi-suggest.js";

const mohe = {
  district: {
    districtName: "漠河",
    districtType: "County",
    parents: [
      { districtName: "大兴安岭", districtType: "City" },
      { districtName: "黑龙江", districtType: "Province" },
    ],
  },
};

test("数字日期中点不把单一纪念馆误判成组合地点", () => {
  assert.deepEqual(pickBestPoi("五·六火灾纪念馆", {
    poiList: [
      { poiId: 86682, poiName: "大兴安岭五六火灾纪念馆", ...mohe },
      { poiId: 12345, poiName: "五六火灾纪念馆陈列厅", ...mohe },
    ],
  }, { destinationCity: "大兴安岭", province: "黑龙江" }), {
    poiId: 86682,
    poiName: "大兴安岭五六火灾纪念馆",
  });
});

test("真正的中点组合地点仍不得映射为单一 POI", () => {
  assert.equal(pickBestPoi("秦始皇陵博物院·丽山园", {
    poiList: [{ poiId: 1, poiName: "秦始皇陵博物院" }, { poiId: 2, poiName: "丽山园" }],
  }), null);

  assert.equal(pickBestPoi("故宫，颐和园", {
    poiList: [{ poiId: 3, poiName: "故宫，颐和园" }],
  }), null);
});

test("行政前缀身份匹配不放开外省同名或附属点", () => {
  assert.equal(pickBestPoi("五·六火灾纪念馆", {
    poiList: [{
      poiId: 2, poiName: "大兴安岭五六火灾纪念馆", district: {
        districtName: "长沙", districtType: "City",
        parents: [{ districtName: "湖南", districtType: "Province" }],
      },
    }],
  }, { destinationCity: "大兴安岭", province: "黑龙江" }), null);

  assert.equal(pickBestPoi("五·六火灾纪念馆", {
    poiList: [{ poiId: 3, poiName: "大兴安岭五六火灾纪念馆陈列厅", ...mohe }],
  }, { destinationCity: "大兴安岭", province: "黑龙江" }), null);
});
