import test from "node:test";
import assert from "node:assert/strict";
import { bestResourceGroup, buildVehicleResourceQuery, firstResourceGroup, parseVehicleResourceGroupNamePrice, resolveVehicleResource, targetVehicleTotalCost } from "../../src/main/operations/vehicle-resource.js";
import { parseProduct } from "../../src/main/automation/schema/schema.js";

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
});

test("资源组按 resourceGroupName 里的车型价格选择最接近总成本", () => {
  const selected = bestResourceGroup({
    data: {
      list: [
        { resourceGroupId: 101, resourceGroupName: "5座经济1000" },
        { resourceGroupId: 102, resourceGroupName: "5座经济2000" },
      ],
    },
  }, 1900, "5座经济");
  assert.equal(selected?.resourceGroupId, 102);
});

test("资源组名称有价格但都偏离目标时不误选第一条", () => {
  const selected = bestResourceGroup({
    data: {
      list: [
        { resourceGroupId: 101, resourceGroupName: "5座经济2000" },
        { resourceGroupId: 102, resourceGroupName: "5座经济2200" },
      ],
    },
  }, 1000, "5座经济");
  assert.equal(selected, undefined);
});

test("资源组仍可按接口价格字段选择最接近总成本", () => {
  const selected = bestResourceGroup({
    data: {
      list: [
        { resourceGroupId: 101, resourceGroupName: "5座经济A", maxItemPrice: 500 },
        { resourceGroupId: 102, resourceGroupName: "5座经济B", maxItemPrice: 550 },
      ],
    },
  }, 540, "5座经济");
  assert.equal(selected?.resourceGroupId, 102);
});

test("资源组名称价格解析按目标车型取对应价格", () => {
  assert.equal(parseVehicleResourceGroupNamePrice("5座经济1000+5座舒适1100", "5座经济"), 1000);
  assert.equal(parseVehicleResourceGroupNamePrice("5座经济1000+5座舒适1100", "5座舒适"), 1100);
  assert.equal(parseVehicleResourceGroupNamePrice("5座舒适1000", "5座舒适"), 1000);
});

test("targetVehicleTotalCost 优先使用 requestedTotalCost，缺失时不从 commercial.pricing 回退", () => {
  assert.equal(targetVehicleTotalCost({
    basicInfo: { days: 2 },
    operations: { vehicleResource: { requestedTotalCost: 1000 } },
    commercial: { pricing: { adult: 9999, minimumTravelers: 2 } },
  }), 1000);
  assert.equal(targetVehicleTotalCost({
    basicInfo: { days: 2 },
    operations: {},
    commercial: { pricing: { adult: 2000, minimumTravelers: 2 } },
  }), undefined);
});

test("targetVehicleTotalCost 按 50 元档位向上取整", () => {
  assert.equal(targetVehicleTotalCost({
    operations: { vehicleResource: { requestedTotalCost: 498 } },
  }), 500);
  assert.equal(targetVehicleTotalCost({
    operations: { vehicleResource: { requestedTotalCost: 500 } },
  }), 500);
  assert.equal(targetVehicleTotalCost({
    operations: { vehicleResource: { requestedTotalCost: 501 } },
  }), 550);
  assert.equal(targetVehicleTotalCost({
    operations: { vehicleResource: { requestedTotalCost: 560 } },
  }), 600);
  assert.equal(targetVehicleTotalCost({
    operations: { vehicleResource: { requestedTotalCost: 497.5 } },
  }), 500);
  assert.equal(targetVehicleTotalCost({
    operations: { vehicleResource: { requestedTotalCost: 500.1 } },
  }), 550);
});

test("targetVehicleTotalCost 忽略 0、负数和非数字输入", () => {
  assert.equal(targetVehicleTotalCost({
    operations: { vehicleResource: { requestedTotalCost: 0 } },
  }), undefined);
  assert.equal(targetVehicleTotalCost({
    operations: { vehicleResource: { requestedTotalCost: -1 } },
  }), undefined);
  assert.equal(targetVehicleTotalCost({
    operations: { vehicleResource: { requestedTotalCost: "abc" } },
  }), undefined);
});

test("接口只有 ID/Name 时仍可按名称价格匹配且不暴露解析价", () => {
  const selected = bestResourceGroup({
    data: {
      list: [
        { resourceGroupId: 101, resourceGroupName: "5座经济1000" },
      ],
    },
  }, 1000, "5座经济");
  assert.equal(selected?.resourceGroupId, 101);
  assert.equal("resourceGroupMaxItemPrice" in (selected ?? {}), false);
});

test("resolveVehicleResource 新接口只回填资源组 ID/Name 并清理旧车字段", async () => {
  const queries: string[] = [];
  const page = {
    evaluate: async (_fn: unknown, args: { body: { resourceGroupName: string } }) => {
      queries.push(args.body.resourceGroupName);
      return {
        status: 200,
        durationMs: 1,
        ctx: { hasCid: true, cookieNameCount: 1, hasGuidCookie: true, hasVbkLoginCidCookie: false },
        payload: { data: {
          list: [
            { resourceGroupId: 202, resourceGroupName: "5座经济500" },
          ],
        } },
      };
    },
  };
  const result = await resolveVehicleResource(page as never, {
    id: "p",
    name: "太原1天0晚私家团",
    status: "review",
    updatedAt: "2026-08-09T00:00:00.000Z",
    messages: [],
    researchTasks: [],
    product: {
      basicInfo: { days: 1, meetingCity: "太原", destinationCity: "太原" },
      operations: {
        pickupCity: "太原",
        vehicleResource: {
          requestedTotalCost: 498,
          resourceGroupId: 101,
          resourceGroupName: "旧资源组",
          resourceGroupMaxItemPrice: 888,
          vehicleId: 1,
          resourceId: 2,
          vehicleModel: "旧车型",
          resourceName: "旧车辆资源",
          supplierCode: "OLD",
        },
      },
    },
  });
  const vehicle = (result.product.operations as Record<string, unknown>).vehicleResource as Record<string, unknown>;
  assert.equal(vehicle.requestedTotalCost, 498);
  assert.equal(vehicle.resourceGroupId, 202);
  assert.equal(vehicle.resourceGroupName, "5座经济500");
  assert.equal(vehicle.resourceGroupMaxItemPrice, undefined);
  assert.equal(vehicle.vehicleId, undefined);
  assert.equal(vehicle.resourceId, undefined);
  assert.equal(vehicle.vehicleModel, undefined);
  assert.equal(vehicle.resourceName, undefined);
  assert.equal(vehicle.supplierCode, undefined);
  assert.deepEqual(queries, ["5座经济500"]);
  assert.equal(result.resolved?.totalCost, 500);
  assert.equal(result.resolved?.query, "5座经济500");
  assert.match(result.note, /5座经济500/);
  assert.equal((result.product as Record<string, unknown>).id, undefined);
  assert.equal((result.product as Record<string, unknown>).product, undefined);
});

test("多日产品按整段行程总价直接匹配资源组，不做日均换算", async () => {
  const queries: string[] = [];
  const page = {
    evaluate: async (_fn: unknown, args: { body: { resourceGroupName: string } }) => {
      queries.push(args.body.resourceGroupName);
      return {
        status: 200,
        durationMs: 1,
        ctx: { hasCid: true, cookieNameCount: 1, hasGuidCookie: true, hasVbkLoginCidCookie: false },
        payload: args.body.resourceGroupName === "5座经济1500"
          ? { data: { list: [{ resourceGroupId: 204, resourceGroupName: "5座经济1500" }] } }
          : { data: { list: [] } },
      };
    },
  };
  const result = await resolveVehicleResource(page as never, {
    id: "p-multi-day-total",
    name: "太原3天2晚私家团",
    status: "review",
    updatedAt: "2026-08-09T00:00:00.000Z",
    messages: [],
    researchTasks: [],
    product: {
      basicInfo: { days: 3, meetingCity: "太原", destinationCity: "太原" },
      operations: {
        pickupCity: "太原",
        vehicleResource: { requestedTotalCost: 1500 },
      },
    },
  });

  assert.deepEqual(queries, ["5座经济1500"]);
  assert.equal(result.resolved?.totalCost, 1500);
  assert.equal(result.resolved?.resourceGroupId, 204);
  assert.equal(result.resolved?.query, "5座经济1500");
});

test("resolveVehicleResource fallback 命中时记录实际查询词", async () => {
  const queries: string[] = [];
  const page = {
    evaluate: async (_fn: unknown, args: { body: { resourceGroupName: string } }) => {
      const query = args.body.resourceGroupName;
      queries.push(query);
      return {
        status: 200,
        durationMs: 1,
        ctx: { hasCid: true, cookieNameCount: 1, hasGuidCookie: true, hasVbkLoginCidCookie: false },
        payload: query === "5座500"
          ? { data: { list: [{ resourceGroupId: 303, resourceGroupName: "5座经济500" }] } }
          : { data: { list: [] } },
      };
    },
  };
  const result = await resolveVehicleResource(page as never, {
    id: "p",
    name: "太原1天0晚私家团",
    status: "review",
    updatedAt: "2026-08-09T00:00:00.000Z",
    messages: [],
    researchTasks: [],
    product: {
      basicInfo: { days: 1, meetingCity: "太原", destinationCity: "太原" },
      operations: { pickupCity: "太原", vehicleResource: { requestedTotalCost: 498 } },
    },
  });
  assert.deepEqual(queries, ["5座经济500", "5座500"]);
  assert.equal(result.resolved?.query, "5座500");
  assert.match(result.note, /5座500/);
});

test("resolveVehicleResource 未匹配时保留 requestedTotalCost/清除标记但清理旧匹配和旧车字段", async () => {
  const page = {
    evaluate: async () => ({
      status: 200,
      durationMs: 1,
      ctx: { hasCid: true, cookieNameCount: 1, hasGuidCookie: true, hasVbkLoginCidCookie: false },
      payload: { data: { list: [] } },
    }),
  };
  const originalProduct = {
    basicInfo: { days: 1, meetingCity: "太原", destinationCity: "太原" },
    operations: {
      pickupCity: "太原",
      vehicleResource: {
        requestedTotalCost: 1000,
        requestedTotalCostCleared: true,
        resourceGroupId: 101,
        resourceGroupName: "旧资源组",
        resourceGroupMaxItemPrice: 888,
        vehicleId: 1,
      },
    },
  };
  const result = await resolveVehicleResource(page as never, {
    id: "p",
    name: "太原1天0晚私家团",
    status: "review",
    updatedAt: "2026-08-09T00:00:00.000Z",
    messages: [],
    researchTasks: [],
    product: originalProduct,
  });
  assert.equal(result.resolved, undefined);
  const vehicle = (result.product.operations as Record<string, unknown>).vehicleResource as Record<string, unknown>;
  assert.equal(vehicle.requestedTotalCost, 1000);
  assert.equal(vehicle.requestedTotalCostCleared, true);
  assert.equal(vehicle.resourceGroupId, undefined);
  assert.equal(vehicle.resourceGroupName, undefined);
  assert.equal(vehicle.resourceGroupMaxItemPrice, undefined);
  assert.equal(vehicle.vehicleId, undefined);
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
        requestedTotalCost: 400,
        serviceHoursPerDay: 8,
        serviceKilometersPerDay: 300,
      },
    },
    itinerary: [{ day: 1, title: "太原一日游" }],
  });
  assert.equal(product.operations.vehicleResource.resourceGroupId, 101);
});

test("产品协议允许初始空 vehicleResource 且不默认伪造资源组价格", () => {
  const product = parseProduct({
    sales: { productType: "domesticShort", productForm: "privateTour" },
    basicInfo: {
      supplierProductName: "太原测试私家团",
      supplierProductCode: "TY-TEST-EMPTY",
      subtitle: "太原测试私家团",
      days: 1,
      nights: 0,
      meetingCity: "太原",
      destinationCity: "太原",
      province: "山西",
      operationNotes: "测试用车资源组初始空表。",
    },
    operations: {
      pickupCity: "太原",
      vehicleResource: {},
    },
    itinerary: [{ day: 1, title: "太原一日游" }],
  });
  assert.deepEqual(product.operations.vehicleResource, {});

  const matchedWithoutPrice = parseProduct({
    sales: { productType: "domesticShort", productForm: "groupTour" },
    basicInfo: {
      supplierProductName: "太原测试跟团",
      supplierProductCode: "TY-TEST-GROUP",
      subtitle: "太原测试跟团",
      days: 1,
      nights: 0,
      meetingCity: "太原",
      destinationCity: "太原",
      province: "山西",
      operationNotes: "测试不默认资源组价格。",
    },
    operations: {
      pickupCity: "太原",
      vehicleResource: {
        resourceGroupId: 101,
        resourceGroupName: "5座经济",
      },
    },
    itinerary: [{ day: 1, title: "太原一日游" }],
  });
  assert.equal("resourceGroupMaxItemPrice" in matchedWithoutPrice.operations.vehicleResource, false);
});

test("targetVehicleTotalCost: 用户主动清除后不再自动生成目标总成本", () => {
  const product = {
    operations: {
      vehicleResource: {
        // 用户在 UI 上点过「清除」——sentinel 字段同步写入，target 应返回 undefined。
        requestedTotalCostCleared: true,
      },
    },
    basicInfo: { days: 2 },
    commercial: { pricing: { adult: 1500, minimumTravelers: 2 } },
  };
  assert.equal(targetVehicleTotalCost(product), undefined);
});

test("targetVehicleTotalCost: sentinel 标志会抑制任何回退路径", () => {
  // 「用户清除」是一个强意图：即便后续某个原子写入又送了 requestedTotalCost、
  // 写库的组合里如果还带着 sentinel，下游解析仍以 sentinel 为准。重新传入
  // 一个值时，applyManualReviewField 会主动撤销 sentinel，这个端到端测试
  // 覆盖的是另一条路径（manual-review-field.test.ts）。
  const dirty = {
    operations: {
      vehicleResource: {
        requestedTotalCostCleared: true,
        requestedTotalCost: 500,
      },
    },
    basicInfo: { days: 2 },
    commercial: { pricing: { adult: 1500, minimumTravelers: 2 } },
  };
  assert.equal(targetVehicleTotalCost(dirty), undefined);
});
