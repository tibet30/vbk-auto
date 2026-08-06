import test from "node:test";
import assert from "node:assert/strict";
import { applyProductPatch } from "../../src/main/operations/product-patch.js";
import {
  normalisePresentation,
  normaliseItinerary,
} from "../../src/main/data/product-normalize.js";

test("草稿字段使用 replace 时会创建尚不存在的父对象", () => {
  const product = { basicInfo: { supplierProductName: "太原2天1晚私家团" }, itinerary: [] };

  const result = applyProductPatch(product, [
    { op: "replace", path: "/commercial/packageName", value: "太原2天1晚标准套餐" },
  ]);

  assert.deepEqual(result.commercial, { packageName: "太原2天1晚标准套餐" });
  assert.equal("commercial" in product, false);
});

test("应用新补丁时会同步修正已有的 MiniMax 展示和行程结构", () => {
  const product = {
    basicInfo: { supplierProductName: "太原2天1晚私家团" },
    presentation: { productName: "太原私家团", highlights: ["专车服务"], description: "两天探访太原。" },
    itinerary: [{ day: 1, title: "晋祠探古", summary: "游览晋祠", activities: [{ name: "晋祠博物馆", detail: "参观古建" }], meals: { breakfast: "自理", lunch: "自理", dinner: "自理" }, stay: "太原酒店" }],
  };

  const result = applyProductPatch(product, [{ op: "add", path: "/basicInfo/province", value: "山西" }]);

  assert.deepEqual(result.presentation, { recommendationCategory: "优选行程", recommendation: "两天探访太原。", features: "专车服务" });
  assert.equal((result.itinerary as Array<Record<string, unknown>>)[0].meals, "早餐自理；午餐自理；晚餐自理");
  assert.deepEqual((result.itinerary as Array<Record<string, unknown>>)[0].spots, ["晋祠博物馆"]);
});

test("草稿归一化会移除无效运营占位值", () => {
  const product = {
    operations: { transport: "", pickupCity: "", reusePickupForDropoff: null, hotelSource: "", hotelTier: "待核查", mealsIncluded: "待核查" },
    commercial: { packageName: "", terms: "待核查" },
    itinerary: [],
  };

  const result = applyProductPatch(product, [{ op: "add", path: "/basicInfo/province", value: "山西" }]);

  assert.equal(result.operations, undefined);
  assert.equal(result.commercial, undefined);
});

const day = (n: number) => ({ day: n, title: `第 ${n} 天`, description: `第 ${n} 天描述`, meals: "自理" });
const titlesOf = (result: Record<string, unknown>) =>
  (result.itinerary as Array<Record<string, unknown>>).map((item) => item.title);

test("对数组使用 add 会插入而不是覆盖既有行程", () => {
  const product = { itinerary: [day(1), day(2)] };

  const result = applyProductPatch(product, [
    { op: "add", path: "/itinerary/0", value: { ...day(9), title: "新插入" } },
  ]);

  // RFC6902：对数组下标 add 是插入，原有元素依次后移，不能丢失。
  assert.equal((result.itinerary as unknown[]).length, 3);
  assert.deepEqual(titlesOf(result), ["新插入", "第 1 天", "第 2 天"]);
});

test("路径以 - 结尾时会追加到数组末尾", () => {
  const product = { itinerary: [day(1), day(2)] };

  const result = applyProductPatch(product, [
    { op: "add", path: "/itinerary/-", value: { ...day(3), title: "追加" } },
  ]);

  assert.equal((result.itinerary as unknown[]).length, 3);
  assert.deepEqual(titlesOf(result), ["第 1 天", "第 2 天", "追加"]);
});

test("对数组使用 replace 会就地替换而不改变长度", () => {
  const product = { itinerary: [day(1), day(2)] };

  const result = applyProductPatch(product, [
    { op: "replace", path: "/itinerary/1", value: { ...day(2), title: "已替换" } },
  ]);

  assert.equal((result.itinerary as unknown[]).length, 2);
  assert.deepEqual(titlesOf(result), ["第 1 天", "已替换"]);
});

test("缺少 value 的 add 或 replace 会被拒绝，不会静默删除字段", () => {
  const product = {
    presentation: { recommendationCategory: "优选行程", recommendation: "两天探访太原。", features: "专车服务" },
    itinerary: [day(1)],
  };

  // 缺 value 时赋值为 undefined，JSON.stringify 会整段丢弃该字段，
  // 这会让一次格式不规范的模型回复静默删掉已经写好的内容。
  assert.throws(() => applyProductPatch(product, [{ op: "replace", path: "/presentation" }]), /value/);
  assert.throws(() => applyProductPatch(product, [{ op: "add", path: "/basicInfo/subtitle" }]), /value/);
});

test("越界的数组下标会被拒绝", () => {
  const product = { itinerary: [day(1)] };

  assert.throws(() => applyProductPatch(product, [{ op: "replace", path: "/itinerary/5", value: day(5) }]), /行程/);
  assert.throws(() => applyProductPatch(product, [{ op: "remove", path: "/itinerary/9" }]), /行程/);
});

test("normalisePresentation 仅在 recommendations 合法时保留", () => {
  const valid = normalisePresentation({
    recommendationCategory: "优选行程",
    recommendation: "两天探访太原。",
    features: "专车服务",
    recommendations: [
      { category: "优选行程", text: "深度探访晋祠" },
      { category: "精选酒店", text: "入住市中心" },
      { category: "缤纷景点", text: "三大必去" },
    ],
  });
  assert.deepEqual(valid?.recommendations, [
    { category: "优选行程", text: "深度探访晋祠" },
    { category: "精选酒店", text: "入住市中心" },
    { category: "缤纷景点", text: "三大必去" },
  ]);
});

test("normalisePresentation 会拒绝非法 recommendations：长度不对、空白 text、未知分类、重复分类", () => {
  const make = (recommendations: unknown) =>
    normalisePresentation({
      recommendationCategory: "优选行程",
      recommendation: "两天探访太原。",
      features: "专车服务",
      recommendations,
    });

  assert.equal(make([{ category: "优选行程", text: "a" }]).recommendations, undefined);
  assert.equal(
    make([
      { category: "优选行程", text: "a" },
      { category: "精选酒店", text: "b" },
      { category: "缤纷景点", text: "c" },
      { category: "特色美食", text: "d" },
    ]).recommendations,
    undefined,
  );
  assert.equal(
    make([
      { category: "优选行程", text: "  " },
      { category: "精选酒店", text: "b" },
      { category: "缤纷景点", text: "c" },
    ]).recommendations,
    undefined,
  );
  assert.equal(
    make([
      { category: "未知分类", text: "a" },
      { category: "精选酒店", text: "b" },
      { category: "缤纷景点", text: "c" },
    ]).recommendations,
    undefined,
  );
  assert.equal(
    make([
      { category: "优选行程", text: "a" },
      { category: "优选行程", text: "b" },
      { category: "缤纷景点", text: "c" },
    ]).recommendations,
    undefined,
  );
  // 非数组直接拒绝
  assert.equal(
    normalisePresentation({
      recommendationCategory: "优选行程",
      recommendation: "两天探访太原。",
      features: "专车服务",
      recommendations: "优选行程：a",
    })?.recommendations,
    undefined,
  );
});

test("normaliseItinerary 保留合法 activities 并兼容 name/title", () => {
  const result = normaliseItinerary([
    {
      day: 1,
      title: "第一天",
      activities: [
        { time: "09:00", name: "晋祠博物馆", detail: "参观古建", type: "visit" },
        { time: "12:00", title: "午餐", detail: "自理", type: "meal" },
      ],
    },
  ]);
  assert.deepEqual((result as Array<Record<string, unknown>>)[0].activities, [
    { time: "09:00", title: "晋祠博物馆", detail: "参观古建", type: "visit" },
    { time: "12:00", title: "午餐", detail: "自理", type: "meal" },
  ]);
});

test("normaliseItinerary 对非法 activities 拒绝保留：缺字段、空字段、未知 type 降级", () => {
  const result = normaliseItinerary([
    {
      day: 1,
      title: "第一天",
      activities: [
        { time: "09:00", title: "晋祠博物馆", detail: "参观古建", type: "sightseeing" }, // 未知 -> other
        { time: "", title: "无时间", detail: "x", type: "visit" }, // 空 time -> 丢弃
        { time: "10:00", title: "   ", detail: "x", type: "visit" }, // 空 title -> 丢弃
        { time: "11:00", title: "无详情", detail: "", type: "visit" }, // 空 detail -> 丢弃
        { time: "12:00", title: "午餐", detail: "自理", type: "meal" }, // 合法
      ],
    },
  ]) as Array<Record<string, unknown>>;
  const activities = result[0].activities as Array<Record<string, unknown>>;
  assert.equal(activities.length, 2);
  assert.deepEqual(activities[0], { time: "09:00", title: "晋祠博物馆", detail: "参观古建", type: "other" });
  assert.deepEqual(activities[1], { time: "12:00", title: "午餐", detail: "自理", type: "meal" });
});

test("应用产品 patch 后 recommendations 与 activities 字段仍存在", () => {
  const product = {
    basicInfo: { supplierProductName: "太原2天1晚私家团", province: "山西" },
    presentation: {
      recommendationCategory: "优选行程",
      recommendation: "两天探访太原。",
      features: "专车服务",
      recommendations: [
        { category: "优选行程", text: "深度探访晋祠" },
        { category: "精选酒店", text: "入住市中心" },
        { category: "缤纷景点", text: "三大必去" },
      ],
    },
    itinerary: [
      {
        day: 1,
        title: "第一天",
        activities: [{ time: "09:00", name: "晋祠博物馆", detail: "参观古建", type: "visit" }],
        meals: { breakfast: "自理", lunch: "自理", dinner: "自理" },
      },
    ],
  };

  const result = applyProductPatch(product, [
    { op: "add", path: "/basicInfo/subtitle", value: "两天私家团" },
  ]);

  const presentation = result.presentation as Record<string, unknown>;
  assert.deepEqual(presentation.recommendations, [
    { category: "优选行程", text: "深度探访晋祠" },
    { category: "精选酒店", text: "入住市中心" },
    { category: "缤纷景点", text: "三大必去" },
  ]);
  const day = (result.itinerary as Array<Record<string, unknown>>)[0];
  assert.deepEqual(day.activities, [
    { time: "09:00", title: "晋祠博物馆", detail: "参观古建", type: "visit" },
  ]);
});
