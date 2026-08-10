import test from "node:test";
import assert from "node:assert/strict";
import { applyManualReviewField } from "../../src/main/operations/manual-review-field.js";

const baseProduct = {
  sales: { productType: "domesticShort", productForm: "privateTour", splitGroup: false },
  basicInfo: {
    supplierProductName: "太原2天1晚私家团",
    supplierProductCode: "TY-1",
    subtitle: "太原经典私家团",
    days: 2,
    nights: 1,
    meetingCity: "太原",
    destinationCity: "太原",
    province: "山西",
    operationNotes: "无",
  },
  operations: {
    transport: "charter",
    pickupCity: "太原",
    reusePickupForDropoff: true,
    hotelSource: "nonPlatform",
    hotelTier: "当地3钻酒店/-3",
    mealsIncluded: false,
    bookingControls: { advanceBooking: { days: 1, time: "12:00" } },
    vehicleResource: {
      resourceGroupId: 88231,
      resourceGroupName: "太原用车组",
      serviceHoursPerDay: 8,
      serviceKilometersPerDay: 300,
    },
  },
  commercial: {
    packageName: "标准套餐",
    pricing: { currency: "CNY", adult: 1500, child: 1200, minimumTravelers: 2 },
  },
  itinerary: [
    { day: 1, title: "D1", description: "首日", hotel: "太原酒店", meals: "自理" },
    { day: 2, title: "D2", description: "次日", hotel: "", meals: "自理" },
  ],
};

test("手动调整成人儿童估价时保留最低成团人数", () => {
  const product = { commercial: { pricing: { currency: "CNY", adult: 1500, child: 1200, minimumTravelers: 2 } } };
  const next = applyManualReviewField(product, { field: "pricing", adult: 1680, child: 980 });
  assert.deepEqual((next.commercial as Record<string, unknown>).pricing, { currency: "CNY", adult: 1680, child: 980, minimumTravelers: 2 });
  assert.equal(((product.commercial.pricing) as { adult: number }).adult, 1500);
});

test("手动调整会拒绝无效价格", () => {
  assert.throws(() => applyManualReviewField({}, { field: "pricing", adult: 0, child: 100 }), /成人价/);
  assert.throws(() => applyManualReviewField({}, { field: "pricing", adult: 1000, child: -1 }), /儿童价/);
  assert.throws(() => applyManualReviewField({}, { field: "pricing", adult: Number.NaN, child: 0 }), /成人价/);
});

test("副标题写入保留其它基础信息字段", () => {
  const next = applyManualReviewField(baseProduct, { field: "basicInfoSubtitle", subtitle: "  太原精品两日游  " });
  const basic = (next.basicInfo as Record<string, unknown>);
  assert.equal(basic.subtitle, "太原精品两日游");
  assert.equal(basic.supplierProductName, "太原2天1晚私家团");
  assert.equal(basic.province, "山西");
  // 不污染原对象
  assert.equal((baseProduct.basicInfo as Record<string, unknown>).subtitle, "太原经典私家团");
});

test("副标题长度低于 2 字符会被拒绝", () => {
  assert.throws(() => applyManualReviewField(baseProduct, { field: "basicInfoSubtitle", subtitle: "x" }), /副标题/);
});

test("副标题长度超过 80 字符会被拒绝", () => {
  const longText = "x".repeat(81);
  assert.throws(() => applyManualReviewField(baseProduct, { field: "basicInfoSubtitle", subtitle: longText }), /副标题/);
});

test("管家联系人写入完整 ContactCardSelection 并保留 advanceBooking", () => {
  const next = applyManualReviewField(baseProduct, {
    field: "butlerContact",
    selection: { contactCardId: 1753732, displayName: "张三", providerId: 1279416 },
  });
  const ops = next.operations as Record<string, unknown>;
  const bc = ops.bookingControls as Record<string, unknown>;
  assert.deepEqual(bc.butler, { contactCardId: 1753732, displayName: "张三", providerId: 1279416 });
  // 提前预订字段不被覆盖
  assert.deepEqual(bc.advanceBooking, { days: 1, time: "12:00" });
});

test("管家联系人 selection=null 时清空但保留其它 bookingControls", () => {
  const next = applyManualReviewField(baseProduct, { field: "butlerContact", selection: null });
  const bc = (next.operations as Record<string, unknown>).bookingControls as Record<string, unknown>;
  assert.equal(bc.butler, undefined);
  assert.deepEqual(bc.advanceBooking, { days: 1, time: "12:00" });
});

test("管家联系人 selection 缺少 ID/姓名会被拒绝", () => {
  assert.throws(() => applyManualReviewField(baseProduct, {
    field: "butlerContact",
    selection: { contactCardId: 1, providerId: 1, displayName: "" },
  }), /管家联系人/);
  assert.throws(() => applyManualReviewField(baseProduct, {
    field: "butlerContact",
    selection: { contactCardId: -1, providerId: 1, displayName: "x" },
  }), /管家联系人/);
});

test("用车资源组只写 requestedDailyCost 时其它字段保持不变", () => {
  const next = applyManualReviewField(baseProduct, {
    field: "vehicleResource",
    requestedDailyCost: 380,
  });
  const vr = (next.operations as Record<string, unknown>).vehicleResource as Record<string, unknown>;
  assert.equal(vr.requestedDailyCost, 380);
  assert.equal(vr.resourceGroupId, 88231);
  assert.equal(vr.resourceGroupName, "太原用车组");
});

test("用车资源组 requestedDailyCost=null 表示清空 AI 预估日价", () => {
  const productWithCost = { ...baseProduct, operations: { ...baseProduct.operations, vehicleResource: { ...baseProduct.operations.vehicleResource, requestedDailyCost: 500 } } };
  const next = applyManualReviewField(productWithCost, { field: "vehicleResource", requestedDailyCost: null });
  const vr = (next.operations as Record<string, unknown>).vehicleResource as Record<string, unknown>;
  assert.equal("requestedDailyCost" in vr, false);
});

test("手动复核不能写入 resourceGroupMaxItemPrice", () => {
  const next = applyManualReviewField(baseProduct, {
    field: "vehicleResource",
    resourceGroupMaxItemPrice: 600,
  } as never);
  const vr = (next.operations as Record<string, unknown>).vehicleResource as Record<string, unknown>;
  assert.equal(vr.resourceGroupMaxItemPrice, undefined);
});

test("AI 预估日价必须大于 0 或传 null", () => {
  assert.throws(() => applyManualReviewField(baseProduct, {
    field: "vehicleResource",
    requestedDailyCost: 0,
  }), /AI 预估日价/);
});

test("车辆资源组空表也能独立写入 requestedDailyCost", () => {
  const product = {
    ...baseProduct,
    operations: {
      ...baseProduct.operations,
      vehicleResource: undefined,
    },
  };
  const next = applyManualReviewField(product, {
    field: "vehicleResource",
    requestedDailyCost: 420,
  });
  const vr = (next.operations as Record<string, unknown>).vehicleResource as Record<string, unknown>;
  assert.equal(vr.requestedDailyCost, 420);
  assert.equal(vr.resourceGroupId, undefined);
  assert.equal(vr.resourceGroupName, undefined);
});

test("applyManualReviewField 不修改原 product", () => {
  const original = JSON.stringify(baseProduct);
  applyManualReviewField(baseProduct, { field: "pricing", adult: 9999, child: 8888 });
  applyManualReviewField(baseProduct, { field: "basicInfoSubtitle", subtitle: "新副标题新副标题" });
  assert.equal(JSON.stringify(baseProduct), original);
});

test("清空 requestedDailyCost 时写入 sentinel 字段，区分「从未设置」与「被主动清除」", () => {
  const next = applyManualReviewField(baseProduct, { field: "vehicleResource", requestedDailyCost: null });
  const vr = (next.operations as Record<string, unknown>).vehicleResource as Record<string, unknown>;
  assert.equal("requestedDailyCost" in vr, false);
  // sentinel 是与 requestedDailyCost 同级的轻量标记，让下游 targetVehicleDailyCost
  // 能区分两种意图。
  assert.equal(vr.requestedDailyCostCleared, true);
});

test("重新填 requestedDailyCost 会撤销清除 sentinel", () => {
  const cleared = applyManualReviewField(baseProduct, { field: "vehicleResource", requestedDailyCost: null });
  const next = applyManualReviewField(cleared, { field: "vehicleResource", requestedDailyCost: 620 });
  const vr = (next.operations as Record<string, unknown>).vehicleResource as Record<string, unknown>;
  assert.equal(vr.requestedDailyCost, 620);
  assert.equal("requestedDailyCostCleared" in vr, false);
});
