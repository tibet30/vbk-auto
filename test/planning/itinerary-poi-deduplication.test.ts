import assert from "node:assert/strict";
import test from "node:test";
import {
  dedupeProductItineraryPois,
  dedupeSameDayItinerarySpots,
} from "../../src/shared/itinerary-poi-deduplication.js";

test("相同原名同时间的重复副本合并，不同游览时间保留", () => {
  const source = [
    { name: '拉昂措', poiName: '拉昂错', poiId: 85599, timeOfDay: 'morning' },
    { name: '拉昂措', poiName: '拉昂错', poiId: 85599, timeOfDay: 'morning', city: '阿里' },
    { name: '拉昂措', poiName: '拉昂错', poiId: 85599, timeOfDay: 'afternoon' },
  ];
  const result = dedupeSameDayItinerarySpots(structuredClone(source));
  assert.equal(result.length, 2);
  assert.deepEqual(result.map((s: any) => s.timeOfDay), ['morning', 'afternoon']);
  assert.equal((result[0] as any).city, '阿里');
});

test("括号说明和游览动作是原安排的一部分，不能因相同POI被去掉", () => {
  const names = ['广济桥（不上桥）', '广济桥（上桥游览）', '广济桥', '广济桥游览'];
  const result = dedupeSameDayItinerarySpots(names.map(name => ({
    name, poiName: '广济桥', poiId: 79621, timeOfDay: 'morning',
  })));
  assert.deepEqual(result.map((spot: any) => spot.name), names);
});

test("同一天匹配到同一携程 POI 的不同原路线名称均保留", () => {
  const result = dedupeSameDayItinerarySpots([
    { name: "羊卓雍措", poiName: "羊卓雍错", poiId: 82105, relation: "and" },
    { name: "羊卓雍湖", poiName: "羊卓雍错", poiId: 82105, city: "山南", relation: "and" },
  ]);

  assert.equal(result.length, 2);
  assert.deepEqual(result.map((spot: any) => spot.name), ['羊卓雍措', '羊卓雍湖']);
});

test("行政途经点不能仅凭同ID被偷偷改名或删除", () => {
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

  assert.deepEqual(result.map((spot: any) => spot.name), ['札达', '扎达土林']);
});

test("不同原名不能借相同官方名合并或填入另一槽位的ID", () => {
  const result = dedupeSameDayItinerarySpots([
    { name: "希夏邦马峰冰川群", poiName: "希夏邦马峰", poiId: null },
    { name: "希夏邦马", poiName: "希夏邦马峰", poiId: 85090, province: "西藏" },
  ]);

  assert.equal(result.length, 2);
  assert.equal((result[0] as any).poiId, null);
  assert.equal((result[1] as any).poiId, 85090);
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

  assert.equal(result.itinerary[0].spots.length, 2);
  assert.equal(result.itinerary[1].spots.length, 1);
  assert.equal(product.itinerary[0].spots.length, 2);
});
