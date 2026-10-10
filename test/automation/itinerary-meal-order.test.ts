import assert from "node:assert/strict";
import test from "node:test";
import { orderItineraryMeals } from "../../src/main/automation/ctrip/itinerary-api/meal-order.js";
import { buildDayDescription } from "../../src/main/automation/ctrip/itinerary-api/itinerary-transform.js";
const card = (name: string, time: string, id: number) => ({ activeType: { name }, takeoffTime: { name: time }, tourDailyInfoId: id, description: `保留${id}`, sort: id });

test("历史行程把22点观星放在18点晚餐之前时，仅调整餐饮位置并保留所有卡片内容", () => {
  const input = [card("飞机", "不限", 1), card("交通", "全天", 2), card("景点", "上午", 3), card("餐饮", "12:00", 4), card("景点", "下午", 5), card("其他", "22:00", 6), card("餐饮", "18:00", 7), card("酒店", "不限", 8)];
  const original = structuredClone(input);
  const output = orderItineraryMeals(input);
  assert.deepEqual(output.map(n => n.tourDailyInfoId), [1,2,3,4,5,7,6,8]);
  assert.deepEqual(input, original);
  for (const node of output) assert.deepEqual({ ...node, sort: 0 }, { ...input.find(n => n.tourDailyInfoId === node.tourDailyInfoId), sort: 0 });
  assert.deepEqual(orderItineraryMeals(output), output);
});

test("新生成的行程晚餐先于夜间活动，时间和用户活动内容保持不变", () => {
  const day = buildDayDescription({ index: 0, totalDays: 2, operations: { transport: "charter" }, stations: {},
    day: { day: 1, title: "天峻观星", spots: [], activities: [{ type: "other", title: "石林观星", detail: "保留观星", time: "22:00" }] } });
  const times = day.tourDailyInfos.map(n => (n.takeoffTime as {name?: string})?.name);
  assert.ok(times.indexOf("18:00") < times.indexOf("22:00"));
  assert.equal(day.tourDailyInfos.find(n => n.activeType?.name === "其他")?.description, "22:00 石林观星：保留观星");
});

test("未知时段和未定时间保持原位置，不猜测活动时间或修改业务卡片顺序", () => {
  const input = [card("集合", "", 1), card("其他", "待定", 2), card("景点", "下午", 3), card("餐饮", "18:00", 4), card("其他", "22:00", 5), card("解散", "不限", 6)];
  assert.deepEqual(orderItineraryMeals(input), input);
});
