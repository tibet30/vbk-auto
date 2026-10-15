import assert from "node:assert/strict";
import test from "node:test";
import {
  screenManualPoiCandidates,
  verifiedMappingForManualPoi,
  verifyManualPoiSelection,
} from "../../src/main/operations/manual-review-poi-selection.ts";

const product = {
  basicInfo: { destinationCity: "西安", province: "陕西", userIdea: "城固张骞故里" },
  itinerary: [{
    day: 1,
    title: "汉中至城固张骞故里",
    description: "前往城固张骞故里",
    spots: [{ name: "张骞故里", poiName: null, poiId: null }],
  }],
};

const detail = {
  httpStatus: 200,
  businessStatus: "Success",
  poiListCount: 2,
  best: { poiName: "张骞公园-张骞纪念馆", poiId: 38513254 },
  candidates: [
    { index: 0, poiName: "张骞公园-张骞纪念馆", poiId: 38513254, province: "新疆", city: "喀什地区", district: "喀什市", selectable: true, textFields: [] },
    { index: 1, poiName: "张骞纪念馆", poiId: 151283243, province: "陕西", city: "汉中", district: "城固", selectable: true, textFields: [] },
  ],
};

test("手动 POI 候选保留展示，但外省候选不可选择且不能成为 best", () => {
  const screened = screenManualPoiCandidates(product, 0, 0, detail);
  assert.equal(screened.candidates[0]?.selectable, false);
  assert.equal(screened.candidates[1]?.selectable, true);
  assert.equal(screened.best, null);
});

test("手动 POI 保存拒绝外省候选，并用当前平台候选重建合法写入", () => {
  assert.throws(() => verifyManualPoiSelection(product, {
    field: "itinerarySpotPoi", dayIndex: 0, spotIndex: 0,
    poiName: "张骞公园-张骞纪念馆", poiId: 38513254,
    province: "陕西", city: "汉中", district: "城固",
  }, detail), /地域约束不匹配/);

  const verified = verifyManualPoiSelection(product, {
    field: "itinerarySpotPoi", dayIndex: 0, spotIndex: 0,
    poiName: "伪造名称", poiId: 151283243,
    province: "新疆", city: "喀什", district: "喀什市",
  }, detail);
  assert.deepEqual(verified, {
    field: "itinerarySpotPoi", dayIndex: 0, spotIndex: 0,
    poiName: "张骞纪念馆", poiId: 151283243,
    province: "陕西", city: "汉中", district: "城固",
  });
});

/** 太白山唐镇温泉：截图里的真实产品（西安锚点，同日的太白山唐镇已绑定 宝鸡/眉县）。 */
function taibaishanFixture() {
  const product = {
    basicInfo: { destinationCity: "西安", province: "陕西", userIdea: "1-西安接---住太白山唐镇---泡温泉" },
    itinerary: [{
      day: 1,
      title: "西安接站·太白山唐镇·温泉疗愈",
      spots: [
        { name: "太白山唐镇", poiName: "太白山唐镇", poiId: 112647382, province: "陕西", city: "宝鸡", district: "眉县" },
        { name: "太白山唐镇温泉", poiName: null, poiId: null },
      ],
    }],
  };
  const detail = {
    httpStatus: 200,
    businessStatus: "Success",
    poiListCount: 3,
    best: null,
    candidates: [
      { index: 0, poiName: "由布院温泉", poiId: 100044, province: "大分县", city: "由布市", selectable: true, textFields: [] },
      { index: 1, poiName: "太白山唐镇·瑞斯丽温泉", poiId: 140960386, province: "陕西", city: "宝鸡", district: "眉县", selectable: true, textFields: [] },
      { index: 2, poiName: "唐镇公园", poiId: 134039509, province: null, city: "上海", district: "上海", selectable: true, textFields: [] },
    ],
  };
  return { product, detail };
}

test("同日已有已核验的同城邻接景点时，人工兜底可选择该城市的温泉子 POI", () => {
  const { product, detail } = taibaishanFixture();
  const screened = screenManualPoiCandidates(product, 0, 1, detail);
  assert.deepEqual(screened.candidates.map(candidate => candidate.selectable), [false, true, false]);
  assert.deepEqual(verifyManualPoiSelection(product, {
    field: "itinerarySpotPoi", dayIndex: 0, spotIndex: 1,
    poiName: "伪造名称", poiId: 140960386, province: "上海", city: "上海", district: "上海",
  }, detail), {
    field: "itinerarySpotPoi", dayIndex: 0, spotIndex: 1,
    poiName: "太白山唐镇·瑞斯丽温泉", poiId: 140960386,
    province: "陕西", city: "宝鸡", district: "眉县",
  });
});

test("邻接景点未核验、异地或外省时，人工兜底仍不可选择", () => {
  const { product, detail } = taibaishanFixture();
  const mutateNeighbour = (patch: Record<string, unknown>) => structuredClone({
    ...product,
    itinerary: [{
      ...product.itinerary[0],
      spots: [{ ...product.itinerary[0]!.spots[0]!, ...patch }, product.itinerary[0]!.spots[1]!],
    }],
  });
  const unverified = mutateNeighbour({ poiName: null, poiId: null });
  const otherCity = mutateNeighbour({ city: "汉中" });
  const otherProvince = mutateNeighbour({ province: "四川" });
  for (const candidate of [unverified, otherCity, otherProvince]) {
    assert.equal(screenManualPoiCandidates(candidate, 0, 1, detail).candidates[1]?.selectable, false);
  }
  const otherProvinceCandidate = {
    ...detail,
    candidates: detail.candidates.map(candidate => candidate.poiId === 140960386 ? { ...candidate, province: "四川" } : candidate),
  };
  assert.equal(screenManualPoiCandidates(product, 0, 1, otherProvinceCandidate).candidates[1]?.selectable, false);
});

/** 已落库、已核验的行程 spot，用于「人工选定 POI 后结清决策门」的取证回归。 */
const savedProduct = {
  itinerary: [{
    day: 4,
    spots: [{ name: "张骞故里", poiName: "张骞纪念馆", poiId: 151283243, province: "陕西", city: "汉中", district: "城固" }],
  }],
};
const savedInput = {
  field: "itinerarySpotPoi" as const,
  dayIndex: 0,
  spotIndex: 0,
  poiName: "张骞纪念馆",
  poiId: 151283243,
};

test("人工选定 POI 后按落库行程取证，供决策门 task 结清", () => {
  assert.deepEqual(verifiedMappingForManualPoi(savedProduct, savedInput), {
    day: 4, spotName: "张骞故里", poiName: "张骞纪念馆", poiId: 151283243,
  });
});

test("落库 POI 与本次写入不一致或缺字段时不予取证", () => {
  const withSpot = (patch: Record<string, unknown>) => ({
    itinerary: [{ day: 4, spots: [{ ...savedProduct.itinerary[0]!.spots[0]!, ...patch }] }],
  });
  // 并发写入在搜索与保存之间改掉了同一 spot：不能借用别人的绑定结清人工决策。
  assert.equal(verifiedMappingForManualPoi(withSpot({ poiId: 38513254 }), savedInput), null);
  assert.equal(verifiedMappingForManualPoi(withSpot({ poiName: "张骞公园-张骞纪念馆" }), savedInput), null);
  assert.equal(verifiedMappingForManualPoi(withSpot({ poiId: null }), savedInput), null);
  assert.equal(verifiedMappingForManualPoi(withSpot({ poiName: "  " }), savedInput), null);
  assert.equal(verifiedMappingForManualPoi(withSpot({ name: "" }), savedInput), null);
  assert.equal(verifiedMappingForManualPoi({ itinerary: [savedProduct.itinerary[0]] }, { ...savedInput, spotIndex: 3 }), null);
  assert.equal(verifiedMappingForManualPoi({}, savedInput), null);
  assert.equal(verifiedMappingForManualPoi({ itinerary: [{ day: 0, spots: [{ name: "张骞故里", poiName: "张骞纪念馆", poiId: 151283243 }] }] }, savedInput), null);
});
