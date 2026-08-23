import assert from "node:assert/strict";
import test from "node:test";
import {
  applyLocalizedDistricts,
  buildSuggestDistrictRequest,
  collectAsciiDistrictJobs,
  isAsciiLocationName,
  pickDistrictById,
} from "../../src/main/infrastructure/suggest-district.js";
import { buildPoiSuggestDetailResult } from "../../src/main/infrastructure/poi-suggest-detail.js";

test("buildSuggestDistrictRequest 固定 locale=zh-CN + contentType=json", () => {
  assert.deepEqual(buildSuggestDistrictRequest("Gyantse"), {
    requestHeader: { locale: "zh-CN" },
    keyword: "Gyantse",
    contentType: "json",
  });
});

test("isAsciiLocationName 仅在无汉字时为 true", () => {
  assert.equal(isAsciiLocationName("Gyantse"), true);
  assert.equal(isAsciiLocationName("Shigatse"), true);
  assert.equal(isAsciiLocationName("江孜"), false);
  assert.equal(isAsciiLocationName("日喀则"), false);
  assert.equal(isAsciiLocationName(""), false);
});

test("collectAsciiDistrictJobs 按 districtId 去重英文行政区", () => {
  const jobs = collectAsciiDistrictJobs([
    {
      localName: "白居寺",
      district: {
        districtId: 2437,
        districtName: "Gyantse",
        districtType: "City",
      },
    },
    {
      localName: "宗山古堡",
      district: {
        districtId: 2437,
        districtName: "Gyantse",
        districtType: "City",
      },
    },
    {
      localName: "晋祠",
      district: {
        districtId: 152,
        districtName: "晋源区",
        districtType: "District",
      },
    },
  ]);
  assert.deepEqual(jobs, [{ districtId: 2437, keyword: "Gyantse" }]);
});

test("pickDistrictById 按 districtId 命中中文名与 parents", () => {
  const hit = pickDistrictById({
    ResponseStatus: { Ack: "Success" },
    districts: [
      {
        districtId: 1719845,
        districtName: "Aygestan",
        districtType: "City",
      },
      {
        districtId: 2437,
        districtName: "江孜",
        districtType: "City",
        parents: [
          { districtId: 100, districtName: "日喀则", districtType: "City" },
          { districtId: 100003, districtName: "西藏", districtType: "Province" },
        ],
      },
    ],
  }, 2437);
  assert.equal(hit?.districtName, "江孜");
  assert.equal(hit?.parents?.[0]?.districtName, "日喀则");
  assert.equal(hit?.parents?.[1]?.districtName, "西藏");
});

test("英文 Gyantse 经 suggestDistrict 映射后候选展示为中文行政区", () => {
  const poiList = [{
    localName: "白居寺",
    poiId: 76349,
    district: {
      districtId: 2437,
      districtName: "Gyantse",
      districtType: "City",
      parents: [
        { districtId: 100, districtName: "Shigatse", districtType: "City" },
        { districtId: 100003, districtName: "Tibet", districtType: "Province" },
      ],
    },
    address: "Gyantse",
  }];
  applyLocalizedDistricts(poiList, new Map([[2437, {
    districtId: 2437,
    districtName: "江孜",
    districtType: "City",
    parents: [
      { districtId: 100, districtName: "日喀则", districtType: "City" },
      { districtId: 100003, districtName: "西藏", districtType: "Province" },
    ],
  }]]));
  const result = buildPoiSuggestDetailResult({
    httpStatus: 200,
    businessStatus: "Success",
    best: { poiName: "白居寺", poiId: 76349 },
    payload: {},
    poiList,
  });
  assert.equal(result.candidates[0]?.province, "西藏");
  assert.equal(result.candidates[0]?.city, "日喀则");
  assert.equal(result.candidates[0]?.district, "江孜");
});
