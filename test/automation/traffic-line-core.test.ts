import test from "node:test";
import assert from "node:assert/strict";

import {
  normaliseTrafficLineConfig,
  normaliseTrafficLineVariant,
} from "../../src/shared/contracts-traffic-line.ts";
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
import {
  isUnavailableTrafficResourceFailure,
  trafficLineChildShouldBeSkipped,
  trainEndpointNeedsReplacement,
} from "../../src/main/automation/ctrip/traffic-line/main.ts";
import {
  deriveTrafficLineCities,
  preflightTrafficLineEndpoints,
  resolveTrafficLineEndpoints,
  resolveTrafficLineCities,
  selectUniqueTrafficLineStation,
} from "../../src/main/automation/ctrip/traffic-line/endpoints.ts";

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
  });
  const parsed = productSchema.safeParse(product);
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  assert.deepEqual(parsed.data.operations?.trafficLine, {
    enabled: true, variants: ["flightRoundTrip", "trainRoundTrip"],
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
  const normalised = normaliseProductDraft(product);
  assert.deepEqual((normalised.operations as Record<string, unknown>).trafficLine, {
    enabled: true, variants: ["trainRoundTrip", "flightRoundTrip"],
  });
  assert.equal(productSchema.safeParse(normalised).success, true);
});

test("线路名归一化统一历史高铁与当前火车名称", () => {
  assert.equal(normaliseTrafficLineVariant(" 高铁往返 "), "trainRoundTrip");
  assert.equal(normaliseTrafficLineVariant("飞机往返"), "flightRoundTrip");
  assert.equal(normaliseTrafficLineVariant("单程飞机"), null);
});

test("交通地点只取首末日唯一 POI 城市，不回退目的地或接送城市", () => {
  assert.deepEqual(deriveTrafficLineCities([
    { spots: [{ city: "大理市" }] },
    { spots: [{ city: "丽江市" }] },
  ]), { arrivalCity: "大理", departureCity: "丽江" });
  assert.throws(() => deriveTrafficLineCities([
    { spots: [{ city: "大理" }, { city: "丽江" }] },
    { spots: [{ city: "丽江" }] },
  ]), /首日行程缺少唯一的 POI 城市/);
  assert.throws(() => deriveTrafficLineCities([{ spots: [] }]), /首日行程缺少唯一的 POI 城市/);
});

test("历史行程缺少 city 时按真实 poiId 回查首末日城市", async () => {
  const calls: number[] = [];
  const cities = new Map([[76348, "日喀则市"], [91485, "日喀则"]]);
  const result = await resolveTrafficLineCities({ evaluate: async () => undefined } as any, [
    { spots: [{ name: "扎什伦布寺", poiName: "扎什伦布寺", poiId: 76348 }] },
    { spots: [{ name: "卡若拉冰川", poiName: "卡若拉冰川", poiId: 91485 }] },
  ], async (spot) => {
    calls.push(spot.poiId!);
    return [{ poiId: spot.poiId!, city: cities.get(spot.poiId!)! }];
  });
  assert.deepEqual(result, { arrivalCity: "日喀则", departureCity: "日喀则" });
  assert.deepEqual(calls, [76348, 91485]);
});

test("POI 接口未按 poiId 唯一确认或同日跨城时安全阻断", async () => {
  await assert.rejects(() => resolveTrafficLineCities({ evaluate: async () => undefined } as any, [
    { spots: [{ name: "扎什伦布寺", poiId: 76348 }] },
  ], async () => [{ poiId: 999, city: "日喀则" }]), /未由 VBK 接口唯一确认/);

  await assert.rejects(() => resolveTrafficLineCities({ evaluate: async () => undefined } as any, [
    { spots: [{ name: "甲", poiId: 1 }, { name: "乙", poiId: 2 }] },
  ], async (spot) => [{ poiId: spot.poiId!, city: spot.poiId === 1 ? "日喀则" : "拉萨" }]), /得到多个城市/);
});

test("交通站点只接受唯一规范化城市候选，不按第一项兜底", () => {
  const station = (name: string, code: string) => ({ type: "air" as const, id: code, code, name, raw: {} });
  assert.equal(selectUniqueTrafficLineStation([station("大理凤仪机场", "DLU")], "大理市", "airport").code, "DLU");
  assert.throws(() => selectUniqueTrafficLineStation([
    station("大理凤仪机场", "DLU"), station("大理机场", "DLX"),
  ], "大理", "airport"), /不会按列表首项猜测/);
  assert.throws(() => selectUniqueTrafficLineStation([station("昆明长水国际机场", "KMG")], "大理", "airport"), /未找到唯一/);
});

test("多个机场必须由站点消歧器选中真实唯一候选", async () => {
  const candidates = [
    { code: "ISP", name: "长岛麦克阿瑟机场" },
    { code: "XIY", name: "咸阳国际机场" },
    { code: "WLP", name: "西安吉拉斯机场" },
  ];
  const calls: unknown[] = [];
  const page = {
    evaluate: async (_fn: unknown, request: any) => {
      calls.push(request.body);
      const payload = request.endpoint.includes("suggestTrainStation")
        ? { ResponseStatus: { Ack: "Success" }, trainStations: [
          { stationNo: 10, stationName: "西安", locationCode: "CN001XAY", geoId: "10" },
        ] }
        : { ResponseStatus: { Ack: "Success" }, airports: candidates };
      return { status: 200, payload, durationMs: 1, ctx: {} };
    },
  } as any;
  const itinerary = [{ spots: [{ city: "西安" }] }];
  const endpoints = await resolveTrafficLineEndpoints(
    page, itinerary, new Date("2026-09-04T00:00:00.000Z"), async (request) => {
      assert.equal(request.stationSubtype, "airport");
      assert.ok(request.candidates.some((candidate) => candidate.id === "XIY" && candidate.text === "咸阳国际机场"));
      return { pickedText: "咸阳国际机场", reasoning: "西安主机场" };
    });
  assert.equal(endpoints.flight.arrival.code, "XIY");
  assert.equal(calls.length, 2);
});

test("录入前按交通方式独立查询，无机场时跳过飞机但保留可用火车", async () => {
  const page = {
    evaluate: async (_fn: unknown, request: any) => ({
      status: 200,
      durationMs: 1,
      ctx: {},
      payload: request.endpoint.includes("suggestTrainStation")
        ? { ResponseStatus: { Ack: "Success" }, trainStations: [
          { stationNo: 92, stationName: "日喀则", locationCode: "CN001RKO" },
        ] }
        : { ResponseStatus: { Ack: "Success" }, airports: [] },
    }),
  } as any;
  const availability = await preflightTrafficLineEndpoints(
    page,
    [{ spots: [{ city: "日喀则" }] }],
    new Date("2026-09-06T00:00:00.000Z"),
  );
  assert.deepEqual(availability.availableVariants, ["trainRoundTrip"]);
  assert.equal(availability.endpointPlan.flight, undefined);
  assert.equal(availability.endpointPlan.train?.arrival.code, "CN001RKO");
  assert.match(availability.unavailableVariants.flightRoundTrip ?? "", /未找到唯一可确认的机场候选/);
});

test("同城多火车站只消歧一次，并排除已被资源校验拒绝的站码", async () => {
  let apiCalls = 0;
  let disambiguationCalls = 0;
  const page = {
    evaluate: async (_fn: unknown, request: any) => {
      apiCalls += 1;
      return {
        status: 200,
        durationMs: 1,
        ctx: {},
        payload: request.endpoint.includes("suggestTrainStation")
          ? { ResponseStatus: { Ack: "Success" }, trainStations: [
            { stationNo: 28, stationName: "成都", locationCode: "CN001CDW" },
            { stationNo: 28, stationName: "成都东", locationCode: "CN001ICW" },
            { stationNo: 28, stationName: "成都南", locationCode: "CN001CNW" },
          ] }
          : { ResponseStatus: { Ack: "Success" }, airports: [{ code: "TFU", name: "天府国际机场" }] },
      };
    },
  } as any;
  const endpoints = await resolveTrafficLineEndpoints(
    page,
    [{ spots: [{ city: "成都" }] }],
    new Date("2026-09-04T00:00:00.000Z"),
    async (request) => {
      disambiguationCalls += 1;
      assert.equal(request.stationSubtype, "train");
      assert.equal(request.desired, "成都主要客运火车站");
      assert.ok(!request.candidates.some((candidate) => candidate.id === "CN001CDW"));
      return { pickedText: "成都东", reasoning: "主高铁站" };
    },
    {},
    { excludedTrainCodes: ["CN001CDW"] },
  );
  assert.equal(endpoints.train.arrival.code, "CN001ICW");
  assert.equal(endpoints.train.departure.code, "CN001ICW");
  assert.equal(endpoints.train.arrival.resourceKey, "28");
  assert.equal(apiCalls, 2);
  assert.equal(disambiguationCalls, 1);
});

test("只有正式资源零城市失败才允许替换已持久化火车站", () => {
  const base = {
    variant: "trainRoundTrip" as const,
    lineDescription: "火车往返",
    completedStages: ["planned", "stationsResolved", "childCreated", "presentationCopied"] as const,
    verified: false,
    failedStage: "resourcesSaved" as const,
  };
  assert.equal(trainEndpointNeedsReplacement([{ ...base, failureReason: "子产品资源回读缺少多出发城市，不能激活套餐。" }]), true);
  assert.equal(trainEndpointNeedsReplacement([{ ...base, failureReason: "当前用户未登录" }]), false);
  assert.equal(trainEndpointNeedsReplacement([{ ...base, failedStage: "itinerarySaved", failureReason: "缺少多出发城市" }]), false);
});

test("平台明确无可售资源时跳过该子产品，避免恢复时重复写入", () => {
  const reason = "子产品资源校验后没有任何可用的多出发城市（站点：日喀则/日喀则），未激活套餐。";
  assert.equal(isUnavailableTrafficResourceFailure(reason), true);
  assert.equal(isUnavailableTrafficResourceFailure("浏览器请求超时"), false);
  assert.equal(trafficLineChildShouldBeSkipped({
    variant: "trainRoundTrip",
    lineDescription: "火车往返",
    completedStages: ["planned", "stationsResolved", "childCreated", "presentationCopied"],
    verified: false,
    failedStage: "resourcesSaved",
    failureReason: reason,
  }), true);
});

test("多个机场缺少安全消歧器时阻断，不按城市字样误选境外机场", async () => {
  const page = {
    evaluate: async (_fn: unknown, request: any) => ({
      status: 200,
      durationMs: 1,
      ctx: {},
      payload: request.endpoint.includes("suggestTrainStation")
        ? { ResponseStatus: { Ack: "Success" }, trainStations: [
          { stationNo: 10, stationName: "西安", locationCode: "CN001XAY" },
        ] }
        : { ResponseStatus: { Ack: "Success" }, airports: [
          { code: "XIY", name: "咸阳国际机场" },
          { code: "WLP", name: "西安吉拉斯机场" },
        ] },
    }),
  } as any;
  await assert.rejects(
    () => resolveTrafficLineEndpoints(page, [{ spots: [{ city: "西安" }] }]),
    /缺少安全消歧器/,
  );
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

test("normaliseTrafficLineConfig 默认启用两种往返，历史禁用仍被保留", () => {
  assert.deepEqual(normaliseTrafficLineConfig({ variants: ["飞机往返"] }), {
    enabled: true,
    variants: ["flightRoundTrip"],
  });
  assert.equal(normaliseTrafficLineConfig(null), undefined);
});
