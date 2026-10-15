import test from "node:test";
import assert from "node:assert/strict";
import {
  findSensitiveItineraryPaths,
  parseItineraryCopyPath,
  readItineraryCopy,
  writeItineraryCopy,
} from "../../src/main/automation/automation.main/itinerary-copy-paths.js";

function product() {
  return {
    itinerary: [
      {
        day: 1,
        title: "西安接站·太白山唐镇·温泉疗愈",
        description: "专车西安接站，前往太白山唐镇入住。",
        spots: [{ name: "太白山唐镇", poiId: 112647382, description: "唐风小镇漫步" }],
        mealDescriptions: ["酒店含早", "服务区自理"],
        activities: [
          { time: "晚上", title: "泡温泉", detail: "体验南山温泉，含室外汤池与药浴。", type: "free" },
          { time: "上午", title: "西安接站", detail: "专车前往西安北站迎接。", type: "transport" },
        ],
      },
    ],
  };
}

test("定位活动详情与其他自由文案，不改景点身份字段", () => {
  const value = product();
  assert.deepEqual(findSensitiveItineraryPaths(value, ["药浴"]), ["/itinerary/0/activities/0/detail"]);
  assert.deepEqual(findSensitiveItineraryPaths(value, ["温泉"]), [
    "/itinerary/0/title", "/itinerary/0/activities/0/title", "/itinerary/0/activities/0/detail",
  ]);
  // 天标题 / 天描述 / 景点描述都是可见文案；景点名称与 poiName 永不出现。
  assert.deepEqual(findSensitiveItineraryPaths(value, ["太白山唐镇"]), [
    "/itinerary/0/title", "/itinerary/0/description",
  ]);
});

test("活动标题与餐食描述同样是可改写文案", () => {
  const value = product();
  assert.deepEqual(findSensitiveItineraryPaths(value, ["泡温泉"]), ["/itinerary/0/activities/0/title"]);
  assert.deepEqual(findSensitiveItineraryPaths(value, ["酒店含早"]), ["/itinerary/0/mealDescriptions/0"]);
});

test("路径解析拒绝景点标题等非文案路径", () => {
  assert.equal(parseItineraryCopyPath("/itinerary/0/spots/0/title"), undefined);
  assert.equal(parseItineraryCopyPath("/itinerary/0/activities/0/description"), undefined);
  assert.equal(parseItineraryCopyPath("/itinerary/0/spots/0/name"), undefined);
  assert.equal(parseItineraryCopyPath("/presentation/recommendation"), undefined);
  assert.deepEqual(parseItineraryCopyPath("/itinerary/1/activities/2/detail"), {
    dayIndex: 1, container: "activities", key: "detail", index: 2,
  });
});

test("读写只落在命中的文案字段上", () => {
  const value = product();
  assert.equal(readItineraryCopy(value, "/itinerary/0/activities/0/detail"), "体验南山温泉，含室外汤池与药浴。");
  writeItineraryCopy(value, "/itinerary/0/activities/0/detail", "体验南山温泉室外汤池。");
  writeItineraryCopy(value, "/itinerary/0/activities/0/title", "温泉汤池体验");
  assert.equal(value.itinerary[0].activities[0].detail, "体验南山温泉室外汤池。");
  assert.equal(value.itinerary[0].activities[0].title, "温泉汤池体验");
  assert.equal(value.itinerary[0].activities[0].time, "晚上");
  assert.equal(value.itinerary[0].spots[0].name, "太白山唐镇");
  assert.throws(() => writeItineraryCopy(value, "/itinerary/0/spots/0/title", "改写"), /不是允许的行程文案路径/);
  assert.throws(() => writeItineraryCopy(value, "/itinerary/0/activities/9/detail", "改写"), /目标不存在/);
});
