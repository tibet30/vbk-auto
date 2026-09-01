import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveLocalTravelAgency,
} from "../../src/main/automation/ctrip/basic-info/api.js";
import {
  hasProductLineResolutionFailure,
  productLineSaveField,
  resolveBasicInfoCityAnchor,
  selectProductLine,
} from "../../src/main/automation/ctrip/basic-info/product-line.js";

const agencies = [
  { localInfoID: 38289, localInfoName: "宾茂乐游", active: "T" },
  { localInfoID: 38207, localInfoName: "宾茂旅业", active: "T" },
  { localInfoID: 99999, localInfoName: "已停用地接社", active: "F" },
];

test("basic API 保留远端已选且可用的地接社", () => {
  assert.deepEqual(resolveLocalTravelAgency({ localInfoID: 38207 }, agencies), {
    id: 38207,
    name: "宾茂旅业",
    selection: "existing",
  });
});

test("basic API 在新草稿未选地接社时使用平台首个可用候选", () => {
  assert.deepEqual(resolveLocalTravelAgency({ localInfoID: 0 }, agencies), {
    id: 38289,
    name: "宾茂乐游",
    selection: "defaulted",
  });
});

test("basic API 不会用任意候选覆盖失效的已选地接社", () => {
  assert.throws(
    () => resolveLocalTravelAgency({ localInfoID: 99999 }, agencies),
    /无法按已选 ID 精确匹配：0 个候选/,
  );
});

test("basic API 在没有可用地接社时明确阻断", () => {
  assert.throws(
    () => resolveLocalTravelAgency({ localInfoID: 0 }, [{ localInfoID: 1, active: "F" }]),
    /未选择且当前账号无可用候选/,
  );
});

test("遗留省级城市锚点使用已确认的接送城市自愈", () => {
  assert.equal(resolveBasicInfoCityAnchor({
    basicInfo: { meetingCity: "河南", destinationCity: "河南" },
    operations: { pickupCity: "郑州" },
  }), "郑州");
});

test("正常城市锚点不被接送城市覆盖", () => {
  assert.equal(resolveBasicInfoCityAnchor({
    basicInfo: { meetingCity: "郑州", destinationCity: "郑州" },
    operations: { pickupCity: "洛阳" },
  }), "郑州");
});

test("产品线优先选择平台返回的精确城市一地线路", () => {
  assert.deepEqual(selectProductLine([
    { lineId: 1, lineName: "河南全景" },
    { lineId: 2, lineName: "郑州一地" },
  ], { destinationCity: "河南", province: "河南" }, "郑州"), {
    lineId: 2,
    lineName: "郑州一地",
  });
});

test("省级目的地没有城市一地线路时唯一匹配省内线路", () => {
  assert.deepEqual(selectProductLine([
    { lineId: 10, lineName: "内蒙+东北" },
    { lineId: 11, lineName: "自营专用-吉林省内" },
    { lineId: 12, lineName: "自营专用-吉林市一地" },
  ], { destinationCity: "吉林", province: "吉林省" }, "长春"), {
    lineId: 11,
    lineName: "自营专用-吉林省内",
  });
});

test("普通城市产品不会降级选择省级全景线路", () => {
  assert.throws(
    () => selectProductLine([
      { lineId: 1, lineName: "河南全景" },
    ], { destinationCity: "郑州", province: "河南" }, "郑州"),
    /平台可选：河南全景/,
  );
});

test("只有历史产品线错误才触发第二次重试降级", () => {
  assert.equal(hasProductLineResolutionFailure({
    attempts: [{ error: "产品线无法按城市/省份精确匹配：长春一地、吉林一地" }],
  }), true);
  assert.equal(hasProductLineResolutionFailure({
    attemptsHistory: [{ error: "省级产品线「吉林省内」无法唯一匹配：2 个候选" }],
    attempts: [],
  }), true);
  assert.equal(hasProductLineResolutionFailure({
    attempts: [{ error: "400 电话无法唯一匹配" }],
  }), false);
});

test("降级保存完全省略 productLineID 字段", () => {
  assert.deepEqual(productLineSaveField(null), {});
  assert.deepEqual(productLineSaveField({ lineId: 11 }), { productLineID: 11 });
});
