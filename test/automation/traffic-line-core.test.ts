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
import {
  isUnavailableTrafficResourceFailure,
  trafficLinePendingSubmitNeedsOneRecoveryRetry,
  trafficLineChildShouldBeSkipped,
  trainEndpointNeedsReplacement,
} from "../../src/main/automation/ctrip/traffic-line/main.ts";
import {
  preflightTrafficLineEndpoints,
  resolveTrafficLineEndpoints,
  resolveTrafficLineDestination,
  selectUniqueTrafficLineStation,
} from "../../src/main/automation/ctrip/traffic-line/endpoints.ts";
import { resolveProductTrafficLineAvailability } from "../../src/main/automation/ctrip/traffic-line/planning-availability.ts";

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

test("大交通端点没有明确指定时才默认产品目的地，不读取首末日景点城市", () => {
  assert.deepEqual(resolveTrafficLineDestination({
    basicInfo: { destinationCity: "日喀则市" },
    itinerary: [{ spots: [{ city: "江孜" }] }, { spots: [{ city: "拉萨" }] }],
  }), { arrivalCity: "日喀则", departureCity: "日喀则" });
  assert.throws(() => resolveTrafficLineDestination({ basicInfo: {} }), /缺少已确认/);
});

test("大交通端点优先使用明确指定的城市，未指定的一端回退目的地", () => {
  assert.deepEqual(resolveTrafficLineDestination({
    basicInfo: { destinationCity: "日喀则市" },
    operations: { trafficLine: { arrivalCity: "拉萨市", departureCity: "西安" } },
  }), { arrivalCity: "拉萨", departureCity: "西安" });
  assert.deepEqual(resolveTrafficLineDestination({
    basicInfo: { destinationCity: "日喀则市" },
    operations: { trafficLine: { arrivalCity: "拉萨市" } },
  }), { arrivalCity: "拉萨", departureCity: "日喀则" });
});

test("端点查询使用目的地，即使首日景点在外地", async () => {
  const page = {
    evaluate: async (_fn: unknown, request: any) => ({
      status: 200,
      durationMs: 1,
      ctx: {},
      payload: request.endpoint.includes("suggestTrainStation")
        ? { ResponseStatus: { Ack: "Success" }, trainStations: [{ stationNo: 92, stationName: "日喀则", locationCode: "CN001RKO" }] }
        : { ResponseStatus: { Ack: "Success" }, airports: [{ code: "RKZ", name: "日喀则和平机场" }] },
    }),
  } as any;

  const availability = await preflightTrafficLineEndpoints(
    page,
    [{ spots: [{ city: "江孜" }] }, { spots: [{ city: "拉萨" }] }],
    new Date("2026-09-09T00:00:00.000Z"),
    undefined,
    { basicInfo: { destinationCity: "日喀则" } },
  );

  assert.equal(availability.endpointPlan.arrivalCity, "日喀则");
  assert.equal(availability.endpointPlan.departureCity, "日喀则");
  assert.deepEqual(availability.availableVariants, ["flightRoundTrip", "trainRoundTrip"]);
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
    },
    { basicInfo: { destinationCity: "西安" } },
  );
  assert.equal(endpoints.flight.arrival.code, "XIY");
  assert.equal(calls.length, 2);
});

test("交通端点消歧的可重入失败最多重试两次", async () => {
  let disambiguateCalls = 0;
  const page = {
    evaluate: async (_fn: unknown, request: any) => ({
      status: 200,
      durationMs: 1,
      ctx: {},
      payload: request.endpoint.includes("suggestTrainStation")
        ? { ResponseStatus: { Ack: "Success" }, trainStations: [
          { stationNo: 92, stationName: "日喀则", locationCode: "CN001RKO" },
        ] }
        : { ResponseStatus: { Ack: "Success" }, airports: [
          { code: "RKZ", name: "日喀则和平机场" },
          { code: "RKX", name: "日喀则备用机场" },
        ] },
    }),
  } as any;

  const availability = await preflightTrafficLineEndpoints(
    page,
    [{ spots: [{ city: "日喀则" }] }],
    new Date("2026-09-09T00:00:00.000Z"),
    async () => {
      disambiguateCalls += 1;
      if (disambiguateCalls < 3) throw new Error("MiniMax 响应超时，请重试。");
      return { pickedText: "日喀则和平机场", reasoning: "第三次消歧成功" };
    },
    { basicInfo: { destinationCity: "日喀则" } },
    ["flightRoundTrip", "trainRoundTrip"],
  );

  assert.equal(disambiguateCalls, 3);
  assert.equal(availability.endpointPlan.flight?.arrival.code, "RKZ");
  assert.deepEqual(availability.availableVariants, ["flightRoundTrip", "trainRoundTrip"]);
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
    undefined,
    { basicInfo: { destinationCity: "日喀则" } },
  );
  assert.deepEqual(availability.availableVariants, ["trainRoundTrip"]);
  assert.equal(availability.endpointPlan.flight, undefined);
  assert.equal(availability.endpointPlan.train?.arrival.code, "CN001RKO");
  assert.match(availability.unavailableVariants.flightRoundTrip ?? "", /未找到唯一可确认的机场候选/);
});

test("初始字段发现保留已确认的火车，不因机场候选需消歧而丢弃它", async () => {
  const page = {
    evaluate: async (_fn: unknown, request: any) => ({
      status: 200,
      durationMs: 1,
      ctx: {},
      payload: request.endpoint.includes("suggestTrainStation")
        ? { ResponseStatus: { Ack: "Success" }, trainStations: [
          { stationNo: 92, stationName: "日喀则", locationCode: "CN001RKO" },
        ] }
        : { ResponseStatus: { Ack: "Success" }, airports: [
          { code: "RKZ", name: "日喀则和平机场" },
          { code: "RKX", name: "日喀则备用机场" },
        ] },
    }),
  } as any;

  const availability = await preflightTrafficLineEndpoints(
    page,
    [{ spots: [{ city: "日喀则" }] }],
    new Date("2026-09-09T00:00:00.000Z"),
    undefined,
    { basicInfo: { destinationCity: "日喀则" } },
    ["flightRoundTrip", "trainRoundTrip"],
    { allowPartialAvailabilityOnUncertain: true },
  );

  assert.deepEqual(availability.availableVariants, ["trainRoundTrip"]);
  assert.match(availability.unavailableVariants.flightRoundTrip ?? "", /缺少安全消歧器/);
});

test("初始规划对飞机和高铁候选分别执行受控消歧，不会因此关闭两类检查", async () => {
  const calls: Array<{ subtype: string; desired: string }> = [];
  const page = {
    evaluate: async (_fn: unknown, request: any) => ({
      status: 200,
      durationMs: 1,
      ctx: {},
      payload: request.endpoint.includes("suggestTrainStation")
        ? { ResponseStatus: { Ack: "Success" }, trainStations: [
          { stationNo: 92, stationName: "日喀则", locationCode: "CN001RKO" },
          { stationNo: 93, stationName: "日喀则西", locationCode: "CN001RKX" },
        ] }
        : { ResponseStatus: { Ack: "Success" }, airports: [
          { code: "RKZ", name: "日喀则和平机场" },
          { code: "RKX", name: "日喀则备用机场" },
        ] },
    }),
  } as any;
  const availability = await resolveProductTrafficLineAvailability({
    db: { getProduct: () => ({ product: {
      basicInfo: { destinationCity: "日喀则" },
      itinerary: [{ spots: [] }],
    } }) } as any,
    browser: { page: async () => page } as any,
    localProductId: "p",
    disambiguateStation: async ({ stationSubtype, desired }) => {
      calls.push({ subtype: stationSubtype, desired });
      return stationSubtype === "train"
        ? { pickedText: "日喀则", reasoning: "当前客运站" }
        : { pickedText: "日喀则和平机场", reasoning: "当前机场" };
    },
  });

  assert.deepEqual(availability?.availableVariants, ["flightRoundTrip", "trainRoundTrip"]);
  assert.equal("scheduleChecks" in (availability ?? {}), false);
  assert.deepEqual(calls, [
    { subtype: "airport", desired: "日喀则" },
    { subtype: "train", desired: "日喀则主要客运火车站" },
  ]);
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
    { basicInfo: { destinationCity: "成都" } },
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
  const packageFailure = "设置火车往返子产品套餐有效失败（Ack=Failure）：产品ID：78199134 出发城市为空,不能打包。";
  assert.equal(isUnavailableTrafficResourceFailure(packageFailure, "trainRoundTrip"), true);
  assert.equal(isUnavailableTrafficResourceFailure(packageFailure, "flightRoundTrip"), false);
  const trainClauseFailure = "子产品资源回读尚未生成火车去返程条款，未保存条款，可安全重试。";
  assert.equal(isUnavailableTrafficResourceFailure(trainClauseFailure, "trainRoundTrip"), false);
  assert.equal(isUnavailableTrafficResourceFailure(trainClauseFailure, "flightRoundTrip"), false);
  assert.equal(isUnavailableTrafficResourceFailure("火车票条款未分别生成去程与返程条款，可安全重试。", "trainRoundTrip"), false);
  assert.equal(isUnavailableTrafficResourceFailure("本班期没有可用交通资源", "trainRoundTrip"), true);
  assert.equal(isUnavailableTrafficResourceFailure("产品没有可用于交通资源核验的销售班期，已保留交通子产品基础信息，跳过班期资源设置。"), true);
  assert.equal(trafficLineChildShouldBeSkipped({
    variant: "trainRoundTrip",
    lineDescription: "火车往返",
    completedStages: ["planned", "childCreated", "clausesSaved"],
    verified: false,
    failedStage: "activated",
    failureReason: packageFailure,
  }), true);
});

test("持续 pending 的班期校验仅允许在超时后受控重提一次", () => {
  const progress = {
    variant: "flightRoundTrip" as const,
    lineDescription: "飞机往返",
    completedStages: ["planned", "stationsResolved", "childCreated", "presentationCopied"] as const,
    verified: false,
    failedStage: "resourcesSaved" as const,
    validationScheduleCount: 3,
    validationDepartureCityCount: 57,
    validationSubmittedAt: "2026-09-12T04:00:00.000Z",
  };
  assert.equal(trafficLinePendingSubmitNeedsOneRecoveryRetry(progress, new Date("2026-09-12T04:09:59.999Z")), false);
  assert.equal(trafficLinePendingSubmitNeedsOneRecoveryRetry(progress, new Date("2026-09-12T04:10:00.000Z")), true);
  assert.equal(trafficLinePendingSubmitNeedsOneRecoveryRetry({
    ...progress,
    validationRecoveryResubmittedAt: "2026-09-12T04:10:00.000Z",
  }, new Date("2026-09-12T05:00:00.000Z")), false);
  assert.equal(trafficLinePendingSubmitNeedsOneRecoveryRetry({
    ...progress,
    validationScheduleCount: undefined,
    validationSubmittedAt: undefined,
  }, new Date("2026-09-12T04:00:00.000Z")), true);
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
    () => resolveTrafficLineEndpoints(page, [{ spots: [{ city: "西安" }] }], new Date(), undefined, { basicInfo: { destinationCity: "西安" } }),
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
