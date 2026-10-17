import assert from "node:assert/strict";
import test from "node:test";
import {
  dedupeProductItineraryPois,
  dedupeSameDayItinerarySpots,
} from "../../src/shared/itinerary-poi-deduplication.js";

test("同一天匹配到同一携程 POI 的别名只保留首个路线名称", () => {
  const result = dedupeSameDayItinerarySpots([
    { name: "羊卓雍措", poiName: "羊卓雍错", poiId: 82105, relation: "and" },
    { name: "羊卓雍湖", poiName: "羊卓雍错", poiId: 82105, city: "山南", relation: "and" },
  ]);

  assert.deepEqual(result, [{
    name: "羊卓雍措", poiName: "羊卓雍错", poiId: 82105, city: "山南", relation: "and",
  }]);
});

test("行政途经点与景点命中同一 POI 时保留景点名称", () => {
  const result = dedupeSameDayItinerarySpots([
    {
      name: "札达", poiName: "札达土林国家地质公园", poiId: 76422,
      province: "西藏", city: "阿里", district: "札达", relation: "and",
    },
    {
      name: "扎达土林", poiName: "札达土林国家地质公园", poiId: 76422,
      province: "西藏", city: "阿里", district: "札达", relation: "and",
    },
  ]);

  assert.deepEqual(result, [{
    name: "扎达土林", poiName: "札达土林国家地质公园", poiId: 76422,
    province: "西藏", city: "阿里", district: "札达", relation: "and",
  }]);
});

test("缺失 ID 的同官方名别名会合并并补齐真实身份", () => {
  const result = dedupeSameDayItinerarySpots([
    { name: "希夏邦马峰冰川群", poiName: "希夏邦马峰", poiId: null },
    { name: "希夏邦马", poiName: "希夏邦马峰", poiId: 85090, province: "西藏" },
  ]);

  assert.deepEqual(result, [{
    name: "希夏邦马峰冰川群", poiName: "希夏邦马峰", poiId: 85090, province: "西藏",
  }]);
});

test("已绑定景点不会提前吞掉同日尚未核验的已知名称别名", () => {
  const result = dedupeSameDayItinerarySpots([
    {
      name: "羊卓雍措", poiName: "羊卓雍错", poiId: 82105,
      timeOfDay: "morning", relation: "and", kind: "attraction",
      province: "西藏", city: "山南", district: "浪卡子",
    },
    {
      name: "羊卓雍湖", poiName: null, poiId: null,
      timeOfDay: "morning", relation: "and", kind: "attraction",
    },
  ]);

  assert.equal(result.length, 2);
  assert.deepEqual(result[0], {
    name: "羊卓雍措", poiName: "羊卓雍错", poiId: 82105,
    timeOfDay: "morning", relation: "and", kind: "attraction",
    province: "西藏", city: "山南", district: "浪卡子",
  });
  assert.deepEqual(result[1], {
    name: "羊卓雍湖", poiName: null, poiId: null,
    timeOfDay: "morning", relation: "and", kind: "attraction",
  });
});

test("两个尚未经过平台解析的近义路线名不提前合并", () => {
  const result = dedupeSameDayItinerarySpots([
    { name: "羊卓雍措", poiName: null, poiId: null, relation: "and" },
    { name: "羊卓雍湖", poiName: null, poiId: null, relation: "and" },
  ]);

  assert.equal(result.length, 2);
});

test("不同真实 ID 与明确二选一槽位不会被合并", () => {
  assert.equal(dedupeSameDayItinerarySpots([
    { name: "景点甲", poiName: "同名景区", poiId: 1 },
    { name: "景点乙", poiName: "同名景区", poiId: 2 },
  ]).length, 2);
  assert.equal(dedupeSameDayItinerarySpots([
    { name: "景点甲", poiName: "同名景区", poiId: 1, relation: "or" },
    { name: "景点乙", poiName: "同名景区", poiId: 1, relation: "or" },
  ]).length, 2);
  assert.equal(dedupeSameDayItinerarySpots([
    { name: "自由活动", kind: "free", poiName: null, poiId: null },
    { name: "自由活动", kind: "free", poiName: null, poiId: null },
  ]).length, 2);
});

test("去重只限同一天且不修改调用方对象", () => {
  const product = {
    itinerary: [
      { day: 1, spots: [{ name: "冈仁波齐", poiName: "冈仁波齐", poiId: 10758151 }, { name: "山体冰川遗迹", poiName: "冈仁波齐", poiId: 10758151 }] },
      { day: 2, spots: [{ name: "远眺冈仁波齐", poiName: "冈仁波齐", poiId: 10758151 }] },
    ],
  };
  const result = dedupeProductItineraryPois(product);

  assert.equal(result.itinerary[0].spots.length, 1);
  assert.equal(result.itinerary[1].spots.length, 1);
  assert.equal(product.itinerary[0].spots.length, 2);
});
