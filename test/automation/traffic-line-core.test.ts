import test from "node:test";
import assert from "node:assert/strict";

import { normaliseTrafficLineConfig, normaliseTrafficLineVariant } from "../../src/shared/contracts-traffic-line.ts";
import { normaliseProductDraft } from "../../src/main/data/product-normalize.ts";
import { productSchema } from "../../src/main/automation/schema/schema-definitions.ts";
import {
  buildTrafficLineProvisionPlan,
  buildTrafficLineSaveRequest,
  buildTrafficLineTargets,
  provisionTrafficLineChildren,
} from "../../src/main/automation/ctrip/traffic-line/orchestrator.ts";
import { normaliseTrafficLineExistingChildren } from "../../src/main/automation/ctrip/traffic-line/api.ts";
import { isTrafficLineChildActive } from "../../src/main/automation/ctrip/traffic-line/relationships.ts";

function productWithTrafficLine(trafficLine: unknown) {
  return {
    sales: { productType: "domesticShort", productForm: "groupTour" },
    basicInfo: {
      supplierProductName: "大理周边三日游",
      supplierProductCode: "TL-001",
      subtitle: "苍山洱海轻松游",
      days: 1,
      nights: 0,
      meetingCity: "大理",
      destinationCity: "大理",
      province: "云南",
      operationNotes: "请提前预约",
    },
    operations: {
      transport: "charter",
      pickupCity: "大理",
      trafficLine,
    },
    itinerary: [{ day: 1, title: "第 1 天", description: "抵达大理", meals: "自理", hotel: "", spots: [] }],
  };
}

test("traffic-line 配置不接收人工机场；站点由运行期会话规划", () => {
  const product = productWithTrafficLine({
    enabled: true,
    variants: ["flightRoundTrip", "trainRoundTrip"],
    arrivalCity: "拉萨",
    departureCity: "西安",
  });
  const parsed = productSchema.safeParse(product);
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  assert.deepEqual(parsed.data.operations?.trafficLine, {
    enabled: true, variants: ["flightRoundTrip", "trainRoundTrip"], arrivalCity: "拉萨", departureCity: "西安",
  });
});

test("normaliseProductDraft 保留历史类型别名但剔除人工机场", () => {
  const product = productWithTrafficLine({
    enabled: true,
    variants: ["高铁往返", "flightRoundTrip", "火车往返", "unknown"],
    airports: {
      arrival: { code: " LJG ", name: " 三义机场 " },
      departure: { code: "", name: "无效机场" },
    },
  });
  (product.operations as Record<string, unknown>).pickupCity = "大理";
  (product.basicInfo as Record<string, unknown>).meetingCity = "丽江";
  (product.basicInfo as Record<string, unknown>).destinationCity = "丽江";
  (product.basicInfo as Record<string, unknown>).destination = "丽江";
  const normalised = normaliseProductDraft(product);
  assert.deepEqual((normalised.operations as Record<string, unknown>).trafficLine, {
    enabled: true, variants: ["trainRoundTrip", "flightRoundTrip"],
  });
  assert.equal(productSchema.safeParse(normalised).success, true);
});

test("产品归一化保留接口已确认的同城火车和飞机配置", () => {
  const product = productWithTrafficLine({
    enabled: true,
    variants: ["flightRoundTrip", "trainRoundTrip"],
  });
  const normalised = normaliseProductDraft(product);
  assert.deepEqual((normalised.operations as Record<string, unknown>).trafficLine, {
    enabled: true,
    variants: ["flightRoundTrip", "trainRoundTrip"],
  });
});

test("线路名归一化统一历史高铁与当前火车名称", () => {
  assert.equal(normaliseTrafficLineVariant(" 高铁往返 "), "trainRoundTrip");
  assert.equal(normaliseTrafficLineVariant("飞机往返"), "flightRoundTrip");
  assert.equal(normaliseTrafficLineVariant("单程飞机"), null);
});

test("关闭配置时不产生目标；目标不携带人工机场选择", () => {
  assert.deepEqual(buildTrafficLineTargets({ enabled: false, variants: ["flightRoundTrip"] }), []);
  const targets = buildTrafficLineTargets({
    enabled: true,
    variants: ["trainRoundTrip", "flightRoundTrip", "trainRoundTrip"],
  });
  assert.deepEqual(targets, [
    { variant: "trainRoundTrip", lineDescription: "火车往返" },
    { variant: "flightRoundTrip", lineDescription: "飞机往返" },
  ]);
});

test("已有子产品按规范线路名复用；重复历史记录会阻断而非猜测", () => {
  const reusable = buildTrafficLineProvisionPlan(
    { enabled: true, variants: ["trainRoundTrip"] },
    [{ productId: "100", lineDescription: "高铁往返" }],
  );
  assert.equal(reusable.actions[0]?.kind, "reuse");

  const ambiguous = buildTrafficLineProvisionPlan(
    { enabled: true, variants: ["flightRoundTrip"] },
    [{ productId: "101", lineDescription: "飞机往返" }, { productId: "102", lineDescription: "飞机往返" }],
  );
  assert.deepEqual(ambiguous.actions[0], {
    kind: "blocked",
    target: { variant: "flightRoundTrip", lineDescription: "飞机往返" },
    reason: "VBK 中存在 2 个「飞机往返」子产品，需先人工确认。",
  });
});

test("子产品有效状态优先读取线路页真实 isActiveInPackage 字段", () => {
  assert.equal(isTrafficLineChildActive({ isActiveInPackage: "T", onlineStatus: "offline" }), true);
  assert.equal(isTrafficLineChildActive({ isActiveInPackage: "F", isActiveInProduct: "T" }), false);
  assert.equal(isTrafficLineChildActive({ status: "VALID" }), true);
});

test("创建请求深拷贝刚回读模板，并按平台规则禁用当日可订", () => {
  const request = buildTrafficLineSaveRequest("parent-1", {
    variant: "flightRoundTrip",
    lineDescription: "飞机往返",
  }, {
    generalInfoDto: { nested: { keep: true } },
    subLineInfoDto: { lineDescription: "地接", advanceBookingDays: 7 },
  });
  assert.deepEqual(request, {
    parentProductId: "parent-1",
    lineDescription: "飞机往返",
    generalInfoDto: { nested: { keep: true } },
    subLineInfoDto: { lineDescription: "飞机往返", advanceBookingDays: 1, advanceBookingTime: "18:00" },
  });
});

test("编排仅创建缺失子产品，绝不激活或处理后续写入", async () => {
  const calls: string[] = [];
  const result = await provisionTrafficLineChildren({
    parentProductId: "parent-2",
    config: { enabled: true, variants: ["flightRoundTrip", "trainRoundTrip"] },
    gateway: {
      async listExistingChildren() {
        calls.push("list");
        return [{ productId: "old-flight", lineDescription: "飞机往返" }];
      },
      async getCreateTemplate() {
        calls.push("template");
        return { generalInfoDto: { shared: true }, subLineInfoDto: { advanceBookingDays: 1 } };
      },
      async createChild(request) {
        calls.push(`create:${request.lineDescription}`);
        return { productId: "new-train" };
      },
    },
  });
  assert.deepEqual(calls, ["list", "template", "create:火车往返"]);
  assert.deepEqual(result.reused, [{ productId: "old-flight", lineDescription: "飞机往返" }]);
  assert.deepEqual(result.created, [{ productId: "new-train", lineDescription: "火车往返" }]);
});

test("关闭配置时编排不读取远端模板或子产品", async () => {
  const result = await provisionTrafficLineChildren({
    parentProductId: "parent-3",
    config: { enabled: false, variants: ["flightRoundTrip"] },
    gateway: {
      async listExistingChildren() { throw new Error("不应读取"); },
      async getCreateTemplate() { throw new Error("不应读取"); },
      async createChild() { throw new Error("不应创建"); },
    },
  });
  assert.deepEqual(result, { plan: { enabled: false, actions: [] }, created: [], reused: [], blocked: [] });
});

test("接口适配器只接收带稳定 ID 和线路名的已有子产品", () => {
  assert.deepEqual(normaliseTrafficLineExistingChildren([
    { subProductId: 123, lineDescription: "飞机往返", packageId: 10, active: true },
    { productId: "456", lineDescription: "火车往返" },
    { subProductId: 0, lineDescription: "缺 ID" },
    { subProductId: 789 },
  ]), [
    { productId: "123", lineDescription: "飞机往返", packageId: "10", active: true },
    { productId: "456", lineDescription: "火车往返" },
  ]);
});

test("normaliseTrafficLineConfig 仅保留明确选择的往返方式，空配置不会推断大交通", () => {
  assert.deepEqual(normaliseTrafficLineConfig({ variants: ["飞机往返"] }), {
    enabled: true,
    variants: ["flightRoundTrip"],
  });
  assert.deepEqual(normaliseTrafficLineConfig({}), {
    enabled: false,
    variants: [],
  });
  assert.deepEqual(normaliseTrafficLineConfig({ enabled: false }), {
    enabled: false,
    variants: [],
  });
  assert.deepEqual(normaliseTrafficLineConfig({ arrivalCity: " 拉萨市 ", departureCity: " 西安 " }), {
    enabled: false,
    variants: [],
    arrivalCity: "拉萨",
    departureCity: "西安",
  });
  assert.equal(normaliseTrafficLineConfig(null), undefined);
});

test("normaliseTrafficLineConfig 丢弃历史规划班期预检字段", () => {
  const result = normaliseTrafficLineConfig({
    enabled: false,
    variants: [],
    availability: {
      endpointPlan: {
        arrivalCity: "日喀则市",
        departureCity: "日喀则",
        resolvedAt: "2026-09-09T00:00:00.000Z",
        train: {
          arrival: { code: "CN001RKO", name: "日喀则", resourceKey: "92" },
          departure: { code: "CN001RKO", name: "日喀则", resourceKey: "92" },
        },
      },
      availableVariants: [],
      unavailableVariants: { trainRoundTrip: "未找到唯一可确认的火车站候选。" },
      scheduleChecks: {
        trainRoundTrip: {
          status: "unavailable",
          checkedDates: ["2026-09-09", "2027-03-10", ""],
          checkedCityCount: 12.8,
          reason: "代表日期内未找到可往返的携程班次。",
        },
      },
    },
  });

  assert.deepEqual(result?.availability, {
    endpointPlan: {
      arrivalCity: "日喀则",
      departureCity: "日喀则",
      resolvedAt: "2026-09-09T00:00:00.000Z",
      train: {
        arrival: { code: "CN001RKO", name: "日喀则", resourceKey: "92" },
        departure: { code: "CN001RKO", name: "日喀则", resourceKey: "92" },
      },
    },
    availableVariants: [],
    unavailableVariants: { trainRoundTrip: "未找到唯一可确认的火车站候选。" },
  });
});
