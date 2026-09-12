import assert from "node:assert/strict";
import test from "node:test";
import { PRODUCT_FORM_LABELS, PRODUCT_FORMS, defaultDailyTransport, isPrivateTourForm, isProductForm, requiresGuide, requiresVehicleResource, supportsSmallGroupSettings, toVbkDailyUseCar } from "../../src/shared/product-form.js";

test("产品形态契约包含四类形态及稳定中文标签", () => {
  assert.deepEqual(PRODUCT_FORMS, ["privateTour", "groupTour", "freeTravel", "semiSelfGuided"]);
  assert.deepEqual(PRODUCT_FORM_LABELS, {
    privateTour: "私家团",
    groupTour: "跟团游",
    freeTravel: "自由行",
    semiSelfGuided: "半自助游",
  });
});

test("产品形态校验只接受四类正式枚举，车辆策略只认私家团", () => {
  for (const value of PRODUCT_FORMS) assert.equal(isProductForm(value), true);
  assert.equal(isProductForm("unknown"), false);
  assert.equal(isPrivateTourForm("privateTour"), true);
  assert.equal(isPrivateTourForm("freeTravel"), false);
});

test("团态规则：私家团用车、跟团游导游、跟团游和半自助拼小团", () => {
  assert.equal(requiresVehicleResource("privateTour"), true);
  assert.equal(requiresVehicleResource("semiSelfGuided"), false);
  assert.equal(requiresGuide("groupTour"), true);
  assert.equal(requiresGuide("semiSelfGuided"), false);
  assert.equal(supportsSmallGroupSettings("groupTour"), true);
  assert.equal(supportsSmallGroupSettings("semiSelfGuided"), true);
  assert.equal(supportsSmallGroupSettings("freeTravel"), false);
});

test("当天用车默认值按私家团、拼小团和自由行区分", () => {
  assert.equal(defaultDailyTransport("privateTour", false), "charter");
  assert.equal(defaultDailyTransport("groupTour", true), "shared");
  assert.equal(defaultDailyTransport("semiSelfGuided", true), "shared");
  assert.equal(defaultDailyTransport("freeTravel", false), "none");
  assert.equal(defaultDailyTransport("groupTour", false), "charter");
});

test("当天用车映射到 VBK 日级 useCar，缺省为包车", () => {
  assert.deepEqual(toVbkDailyUseCar("none"), { key: "N", name: "不含" });
  assert.deepEqual(toVbkDailyUseCar("shared"), { key: "P", name: "拼车" });
  assert.deepEqual(toVbkDailyUseCar("charter"), { key: "B", name: "包车" });
  assert.deepEqual(toVbkDailyUseCar(undefined), { key: "B", name: "包车" });
});
