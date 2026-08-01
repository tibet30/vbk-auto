import test from "node:test";
import assert from "node:assert/strict";
import { estimateVehicleResource, firstResourceGroup } from "../src/main/vehicle-resource.js";
import { parseProduct } from "../src/main/automation/schema.js";

test("太原 5 座经济 8 小时用车估算生成资源组搜索词", () => {
  const estimate = estimateVehicleResource({ city: "太原", days: 2, seats: 5, tier: "经济", serviceHoursPerDay: 8 });
  assert.equal(estimate.dailyCost, 400);
  assert.equal(estimate.totalCost, 800);
  assert.equal(estimate.query, "5座经济400");
});

test("资源组接口返回后按顺序取第一条", () => {
  const selected = firstResourceGroup({
    data: {
      list: [
        { resourceGroupId: 101, resourceGroupName: "5座经济400", maxItemPrice: 400 },
        { resourceGroupId: 102, resourceGroupName: "5座经济450", maxItemPrice: 450 },
      ],
    },
  });
  assert.equal(selected?.resourceGroupId, 101);
  assert.equal(selected?.resourceGroupName, "5座经济400");
  assert.equal(selected?.resourceGroupMaxItemPrice, 400);
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
        resourceGroupName: "5座经济400",
        resourceGroupMaxItemPrice: 400,
        serviceHoursPerDay: 8,
        serviceKilometersPerDay: 300,
      },
    },
    itinerary: [{ day: 1, title: "太原一日游" }],
  });
  assert.equal(product.operations.vehicleResource.resourceGroupId, 101);
});
