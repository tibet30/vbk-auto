import test from "node:test";
import assert from "node:assert/strict";
import { buildVehicleResourceQuery, firstResourceGroup } from "../src/main/vehicle-resource.js";
import { parseProduct } from "../src/main/automation/schema.js";

test("任意城市都不再硬编码 dailyCost / totalCost", () => {
  const query = buildVehicleResourceQuery({ city: "太原", days: 2, seats: 5, tier: "经济", serviceHoursPerDay: 8 });
  assert.equal(query.city, "太原");
  assert.equal(query.query, "5座经济");
  // 关键回归点：不能再产出任何 dailyCost / totalCost；价格完全由 VBK 接口提供。
  assert.equal((query as unknown as Record<string, unknown>).dailyCost, undefined);
  assert.equal((query as unknown as Record<string, unknown>).totalCost, undefined);
});

test("缺城市时抛错，避免静默默认", () => {
  assert.throws(() => buildVehicleResourceQuery({ days: 1, seats: 5, tier: "经济" }), /城市/);
});

test("资源组接口返回后按顺序取第一条", () => {
  const selected = firstResourceGroup({
    data: {
      list: [
        { resourceGroupId: 101, resourceGroupName: "5座经济", maxItemPrice: 400 },
        { resourceGroupId: 102, resourceGroupName: "5座经济", maxItemPrice: 450 },
      ],
    },
  });
  assert.equal(selected?.resourceGroupId, 101);
  assert.equal(selected?.resourceGroupName, "5座经济");
  assert.equal(selected?.resourceGroupMaxItemPrice, 400);
});

test("资源组接口缺少关键字段会被忽略", () => {
  const selected = firstResourceGroup({
    data: {
      list: [
        { resourceGroupName: "缺 ID" },
        { resourceGroupId: 999, resourceGroupName: "" },
      ],
    },
  });
  assert.equal(selected, undefined);
});

test("私家团可只带资源组核心字段通过产品协议", () => {
  const product = parseProduct({
    sales: { productType: "domesticShort", productForm: "privateTour" },
    basicInfo: {
      supplierProductName: "太原测试私家团",
      supplierProductCode: "TY-TEST-1",
      subtitle: "太原测试私家团",
      days: 1,
      nights: 0,
      meetingCity: "太原",
      destinationCity: "太原",
      province: "山西",
      operationNotes: "测试用车资源组核心字段。",
    },
    operations: {
      pickupCity: "太原",
      vehicleResource: {
        resourceGroupId: 101,
        resourceGroupName: "5座经济",
        resourceGroupMaxItemPrice: 400,
        serviceHoursPerDay: 8,
        serviceKilometersPerDay: 300,
      },
    },
    itinerary: [{ day: 1, title: "太原一日游" }],
  });
  assert.equal(product.operations.vehicleResource.resourceGroupId, 101);
});
