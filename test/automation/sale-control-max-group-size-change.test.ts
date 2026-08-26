import test from "node:test";
import assert from "node:assert/strict";
import {
  alternateSmallGroupInputValue,
  smallGroupStateMatches,
} from "../../src/main/automation/ctrip/sale-control/sale-control.controls.js";
import { isOnlyNonStructuredPoiChannelWarning } from "../../src/main/automation/ctrip/sale-control/sale-control.js";

test("最大成团人数初值等于目标值时使用另一个合法值触发变更", () => {
  assert.equal(alternateSmallGroupInputValue(8), 7);
  assert.equal(alternateSmallGroupInputValue(1), 2);
});

test("拼小团远端回读必须同时确认三项业务字段", () => {
  assert.equal(smallGroupStateMatches({ available: true, splitGroup: true, squareGroup: true, maxGroupSize: 8 }, 8), true);
  assert.equal(smallGroupStateMatches({ available: true, splitGroup: true, squareGroup: false, maxGroupSize: 8 }, 8), false);
  assert.equal(smallGroupStateMatches({ available: true, splitGroup: true, squareGroup: true, maxGroupSize: 0 }, 8), false);
  assert.equal(smallGroupStateMatches({ available: false }, 8), false);
});

test("只识别销售控制页面的精确非结构化 POI 渠道警告", () => {
  const exact = [{
    ErrorCode: "null",
    Message: "产品id: 77620535 Ctrip售卖产品中景点、购物点、酒店不可有非结构化poi，请在行程中修改后再添加Ctrip渠道",
  }];
  assert.equal(isOnlyNonStructuredPoiChannelWarning(exact), true);
  assert.equal(isOnlyNonStructuredPoiChannelWarning([{ Message: `${exact[0]!.Message}；另有错误` }]), false);
  assert.equal(isOnlyNonStructuredPoiChannelWarning([]), false);
});
