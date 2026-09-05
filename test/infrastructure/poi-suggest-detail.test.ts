import assert from "node:assert/strict";
import test from "node:test";
import { buildPoiSuggestDetailResult } from "../../src/main/infrastructure/poi-suggest-detail.js";

test("POI 候选严格按真实 suggestPoi district / parents 契约解析行政区域", () => {
  // 真实 VBK 响应（白居寺/江孜）：当前节点可为 City，上级 City=地级市，Province=省。
  const result = buildPoiSuggestDetailResult({
    httpStatus: 200,
    businessStatus: "Success",
    best: { poiName: "白居寺", poiId: 76349 },
    payload: {},
    poiList: [{
      localName: "白居寺",
      poiId: 76349,
      district: {
        districtId: 2437,
        districtName: "Gyantse",
        districtType: "City",
        parents: [
          { districtId: 100, districtName: "Shigatse", districtType: "City" },
          { districtId: 100003, districtName: "Tibet", districtType: "Province" },
          { districtId: 110000, districtName: "China", districtType: "Country" },
          { districtId: 120001, districtName: "Asia", districtType: "Continent" },
        ],
      },
      address: "Gyantse",
    }],
  });
  assert.equal(result.candidates[0]?.province, "Tibet");
  assert.equal(result.candidates[0]?.city, "Shigatse");
  assert.equal(result.candidates[0]?.district, "Gyantse");
  assert.equal(result.candidates[0]?.address, "Gyantse");
});

test("当前 district 本身是唯一 City 时也作为城市返回", () => {
  const result = buildPoiSuggestDetailResult({
    httpStatus: 200,
    businessStatus: "Success",
    best: { poiName: "扎什伦布寺", poiId: 76348 },
    payload: {},
    poiList: [{
      localName: "扎什伦布寺",
      poiId: 76348,
      district: {
        districtName: "日喀则",
        districtType: "City",
        parents: [{ districtName: "西藏", districtType: "Province" }],
      },
    }],
  });
  assert.equal(result.candidates[0]?.province, "西藏");
  assert.equal(result.candidates[0]?.city, "日喀则");
});
