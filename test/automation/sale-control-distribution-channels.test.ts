import test from "node:test";
import assert from "node:assert/strict";
import { shouldSkipDistributionChannel } from "../../src/main/automation/ctrip/sale-control/sale-control.controls.js";

test("销售控制不自动勾选途风渠道", () => {
  assert.equal(shouldSkipDistributionChannel("途风"), true);
  assert.equal(shouldSkipDistributionChannel("途风 "), false);
});

test("销售控制仍跳过泛定制-C，但不误伤其他渠道", () => {
  assert.equal(shouldSkipDistributionChannel("泛定制-C"), true);
  assert.equal(shouldSkipDistributionChannel("飞猪"), false);
});
