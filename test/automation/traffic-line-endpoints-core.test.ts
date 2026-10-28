import test from "node:test";
import assert from "node:assert/strict";

import {
  preflightTrafficLineEndpoints,
  resolveTrafficLineEndpoints,
  resolveTrafficLineDestination,
  selectUniqueTrafficLineStation,
} from "../../src/main/automation/ctrip/traffic-line/endpoints.ts";
import { resolveProductTrafficLineAvailability } from "../../src/main/automation/ctrip/traffic-line/planning-availability.ts";

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
