import test from "node:test";
import assert from "node:assert/strict";
import {
  extractVehicleTotalCost,
  isVehicleResourceOnlyMessage,
} from "../../src/main/ipc/product-ai-vehicle-resource-only.js";

test("用车资源组专项请求会绕开通用 AI 行程 patch", () => {
  assert.equal(isVehicleResourceOnlyMessage("帮我单独生成用车资源组，不要修改行程"), true);
  assert.equal(isVehicleResourceOnlyMessage("生成用车资源组"), true);
  assert.equal(isVehicleResourceOnlyMessage("按全程 3200 元搜索车辆资源组"), true);
});

test("全量产品规划请求不会被误判为用车资源组专项", () => {
  assert.equal(isVehicleResourceOnlyMessage("完整重新规划并补全产品，包含用车资源组"), false);
  assert.equal(isVehicleResourceOnlyMessage("重新生成全部行程和价格"), false);
});

test("行程修复中提及保留用车时不能被用车专项吞掉", () => {
  assert.equal(
    isVehicleResourceOnlyMessage("修复当前产品行程并绑定 POI，保留现有用车资源组，不要改定价"),
    false,
  );
});

test("用车资源组专项请求可从话术中提取全程总成本", () => {
  assert.equal(extractVehicleTotalCost("按全程 3,200 元搜索车辆资源组"), 3200);
  assert.equal(extractVehicleTotalCost("用车预算 0.45 万，生成资源组"), 4500);
  assert.equal(extractVehicleTotalCost("生成用车资源组"), null);
});
