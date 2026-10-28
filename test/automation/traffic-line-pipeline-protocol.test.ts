import test from "node:test";
import assert from "node:assert/strict";

import { ensureTrafficLineApi } from "../../src/main/automation/ctrip/traffic-line/main.ts";
import { ensureTrafficLinePhase, trafficLineConfigForProduct } from "../../src/main/automation/ctrip/traffic-line/run-phase.ts";

test("缺少已核实行程时，完整流水线在任何远端读取/写入前失败", async () => {
  let calls = 0;
  await assert.rejects(() => ensureTrafficLineApi({
    evaluate: async () => { calls += 1; throw new Error("不应调用"); },
  }, "parent-1", { enabled: true, variants: ["flightRoundTrip"] }), /缺少已核实的行程/);
  assert.equal(calls, 0);
});

test("运行阶段不能绕过行程证据门并把部分子产品标记完成", async () => {
  let calls = 0;
  await assert.rejects(() => ensureTrafficLinePhase({
    page: { evaluate: async () => { calls += 1; throw new Error("不应调用"); } },
    parentProductId: "parent-1",
    config: { enabled: true, variants: ["trainRoundTrip"] },
    log: () => {},
  }), /缺少已核实的行程/);
  assert.equal(calls, 0);
});

test("运行阶段复用产品配置里已核验的大交通端点，全子产品未完成时只记录原因", async () => {
  const endpoints = {
    arrivalCity: "成都",
    departureCity: "成都",
    resolvedAt: "2026-09-15T02:09:36.260Z",
    flight: {
      arrival: { code: "TFU", name: "天府国际机场" },
      departure: { code: "TFU", name: "天府国际机场" },
    },
    train: {
      arrival: { code: "CN001ICW", name: "成都东", resourceKey: "28" },
      departure: { code: "CN001ICW", name: "成都东", resourceKey: "28" },
    },
  };
  const seenEndpoints: string[] = [];
  const page = {
    vbkSessionGetText: async () => ({ status: 200, text: '<script>window.__INITIAL_STATE__ = {"childList":[]};</script>' }),
    evaluate: async (_fn: unknown, request: any) => {
      seenEndpoints.push(String(request?.endpoint ?? ""));
      if (/suggestAirport|suggestTrainStation/.test(String(request?.endpoint ?? ""))) {
        throw new Error("不应重新查询站点");
      }
      throw new Error("stopped after endpoint reuse");
    },
  };

  const logs: string[] = [];
  const checkpoints: any[] = [];
  await assert.rejects(() => ensureTrafficLinePhase({
    page,
    parentProductId: "78483120",
    config: {
      enabled: true,
      variants: ["flightRoundTrip", "trainRoundTrip"],
      availability: {
        endpointPlan: endpoints,
        availableVariants: ["flightRoundTrip", "trainRoundTrip"],
        unavailableVariants: {},
      },
    },
    itinerary: [{ spots: [{ city: "成都" }] }],
    log: (message) => logs.push(message),
    onCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
  }), /当前会话已确认可用的交通子产品未完成最终回读.*endpoint reuse/);
  assert.equal(seenEndpoints.some((endpoint) => /suggestAirport|suggestTrainStation/.test(endpoint)), false);
  assert.equal(logs.some((message) => /子产品未完成/.test(message)), true);
  assert.equal(checkpoints.at(-1)?.verifiedAt, undefined);
  assert.match(String(checkpoints.at(-1)?.failureReason), /endpoint reuse/);
});

test("当前可用方式会重验历史 skipped 子产品且不重复创建", async () => {
  let sessionReads = 0;
  const checkpoints: any[] = [];
  const evaluated: string[] = [];
  const page = {
    vbkSessionGetText: async () => {
      sessionReads += 1;
      return {
        status: 200,
        text: '<script>window.__INITIAL_STATE__ = {"childList":[{"subProductId":"79194665","lineDescription":"飞机往返","isActiveInPackage":"T"}]};</script>',
      };
    },
    evaluate: async (_fn: unknown, request: any) => {
      evaluated.push(String(request?.endpoint ?? ""));
      if (String(request?.endpoint).endsWith("getdescriptionInfo")) return {
        status: 200, durationMs: 1, ctx: {},
        payload: { ResponseStatus: { Ack: "Success" }, info: { productDesc: { productDesc: "<p>same</p>" }, pmRcmdItems: [] } },
      };
      throw new Error("纯回读探针失败");
    },
  };
  const result = await ensureTrafficLineApi(page as never, "79189107", {
    enabled: true,
    variants: ["flightRoundTrip"],
    availability: {
      endpointPlan: {
        arrivalCity: "潮州",
        departureCity: "潮州",
        resolvedAt: "2026-10-01T00:00:00.000Z",
        flight: { arrival: { code: "SWA", name: "揭阳潮汕机场" }, departure: { code: "SWA", name: "揭阳潮汕机场" } },
      },
      availableVariants: ["flightRoundTrip"],
      unavailableVariants: {},
    },
  }, {
    itinerary: [{ spots: [{ city: "潮州" }] }],
    endpointPlan: {
      arrivalCity: "潮州",
      departureCity: "潮州",
      resolvedAt: "2026-10-01T00:00:00.000Z",
      flight: { arrival: { code: "SWA", name: "揭阳潮汕机场" }, departure: { code: "SWA", name: "揭阳潮汕机场" } },
    },
    childProgress: [{
      variant: "flightRoundTrip",
      lineDescription: "飞机往返",
      childProductId: "79194665",
      completedStages: ["planned", "stationsResolved", "childCreated"],
      verified: false,
      skipped: true,
      failureReason: "子产品最终正式条款回读缺少：32269。",
    }],
    stableReadbackSamples: 1,
    onChildProgress: (progress) => checkpoints.push(progress),
    stableReadbackIntervalMs: 0,
    sleep: async () => {},
  });
  assert.ok(sessionReads >= 2, "当前可用历史子产品必须进入关系/稳定回读");
  assert.equal(evaluated.some((endpoint) => /saveLineInfo|saveProductClauses|saveClausePackage/.test(endpoint)), false);
  assert.deepEqual(result.children, []);
  assert.equal(result.skipped?.length, 1);
  assert.equal(checkpoints.find((item) => !item.failureReason)?.skipped, false, "重验检查点撤销历史跳过标记");
  assert.equal(checkpoints.at(-1)?.skipped, true, "回读协议失败标为已跳过以便母产品结案");
  assert.equal(checkpoints.at(-1)?.skipReason, "child_failed", "跳过原因是录入失败，不能标成无资源");
  assert.ok(checkpoints.at(-1)?.failedStage, "保留 failedStage 供手动重试");
});

test("当前会话明确不可用时保留 skipped，但不写 verifiedAt 并返回 blocked", async () => {
  const checkpoints: any[] = [];
  const result = await ensureTrafficLinePhase({
    page: { evaluate: async () => { throw new Error("不应读取不可用方式"); } },
    parentProductId: "79189107",
    config: {
      enabled: true,
      variants: ["flightRoundTrip"],
      availability: {
        endpointPlan: { arrivalCity: "潮州", departureCity: "潮州", resolvedAt: "2026-10-01T00:00:00.000Z" },
        availableVariants: [],
        unavailableVariants: { flightRoundTrip: "当前会话未确认可售" },
      },
    },
    itinerary: [{ spots: [{ city: "潮州" }] }],
    checkpoint: {
      children: [{
        variant: "flightRoundTrip",
        lineDescription: "飞机往返",
        childProductId: "79194665",
        completedStages: ["planned", "stationsResolved", "childCreated"],
        verified: false,
        skipped: true,
        failureReason: "当前无可售资源",
      }],
    },
    log: () => {},
    onCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
  });
  assert.equal(result.children.length, 0);
  assert.equal(result.blocked, 1);
  assert.equal(checkpoints.at(-1)?.verifiedAt, undefined);
});

test("单个交通子产品创建失败会跳过并继续其它子产品，不影响母产品阶段成功", async () => {
  const endpoints = {
    arrivalCity: "成都",
    departureCity: "成都",
    resolvedAt: "2026-09-15T02:09:36.260Z",
    flight: {
      arrival: { code: "TFU", name: "天府国际机场" },
      departure: { code: "TFU", name: "天府国际机场" },
    },
    train: {
      arrival: { code: "CN001ICW", name: "成都东", resourceKey: "28" },
      departure: { code: "CN001ICW", name: "成都东", resourceKey: "28" },
    },
  };
  const saveCalls: string[] = [];
  const page = {
    vbkSessionGetText: async () => ({ status: 200, text: '<script>window.__INITIAL_STATE__ = {"childList":[]};</script>' }),
    evaluate: async (_fn: unknown, request: any) => {
      const endpoint = String(request?.endpoint ?? "");
      if (endpoint.endsWith("/getPackageProductDetail")) {
        return {
          status: 200,
          payload: {
            ResponseStatus: { Ack: "Success", Errors: [] },
            generalInfoDto: { keep: true },
            subLineInfoDto: {},
          },
          durationMs: 1,
          ctx: {},
        };
      }
      if (endpoint.endsWith("/saveLineInfo")) {
        saveCalls.push(String(request?.body?.subLineInfoDto?.lineDescription ?? ""));
        throw new Error(`创建失败:${saveCalls.length}`);
      }
      throw new Error(`unexpected endpoint ${endpoint}`);
    },
  };

  const result = await ensureTrafficLineApi(page as never, "78483120", {
    enabled: true,
    variants: ["flightRoundTrip", "trainRoundTrip"],
    availability: {
      endpointPlan: endpoints,
      availableVariants: ["flightRoundTrip", "trainRoundTrip"],
      unavailableVariants: {},
    },
  }, {
    itinerary: [{ spots: [{ city: "成都" }] }],
    endpointPlan: endpoints,
  });

  assert.deepEqual(saveCalls, ["飞机往返", "火车往返"]);
  assert.deepEqual(result.children, []);
  assert.deepEqual(result.skipped?.map((item) => item.variant), ["flightRoundTrip", "trainRoundTrip"]);
});

test("飞机和火车子产品创建没有依赖关系时会并行启动", async () => {
  const endpoints = {
    arrivalCity: "成都",
    departureCity: "成都",
    resolvedAt: "2026-09-19T09:00:00.000Z",
    flight: {
      arrival: { code: "TFU", name: "天府国际机场" },
      departure: { code: "TFU", name: "天府国际机场" },
    },
    train: {
      arrival: { code: "CN001ICW", name: "成都东", resourceKey: "28" },
      departure: { code: "CN001ICW", name: "成都东", resourceKey: "28" },
    },
  };
  const savedChildren: Array<{ subProductId: string; lineDescription: string }> = [];
  const saveStarts: string[] = [];
  let releaseBothSaves: (() => void) | null = null;
  const bothSavesStarted = new Promise<void>((resolve) => { releaseBothSaves = resolve; });
  const saveTimeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("飞机子产品创建未等到火车子产品并行启动")), 50);
  });
  const page = {
    vbkSessionGetText: async () => ({
      status: 200,
      text: `<script>window.__INITIAL_STATE__ = ${JSON.stringify({ childList: savedChildren })};</script>`,
    }),
    evaluate: async (_fn: unknown, request: any) => {
      const endpoint = String(request?.endpoint ?? "");
      if (endpoint.endsWith("/getPackageProductDetail")) {
        return {
          status: 200,
          payload: {
            ResponseStatus: { Ack: "Success", Errors: [] },
            generalInfoDto: { keep: true },
            subLineInfoDto: {},
          },
          durationMs: 1,
          ctx: {},
        };
      }
      if (endpoint.endsWith("/saveLineInfo")) {
        const lineDescription = String(request?.body?.subLineInfoDto?.lineDescription ?? "");
        saveStarts.push(lineDescription);
        if (saveStarts.length === 2) releaseBothSaves?.();
        if (lineDescription === "飞机往返") {
          await Promise.race([bothSavesStarted, saveTimeout]);
        }
        const subProductId = lineDescription === "飞机往返" ? "78483121" : "78483122";
        savedChildren.push({ subProductId, lineDescription });
        return {
          status: 200,
          payload: {
            ResponseStatus: { Ack: "Success", Errors: [] },
            data: { subProductId },
          },
          durationMs: 1,
          ctx: {},
        };
      }
      throw new Error(`stop after concurrent child creation: ${endpoint}`);
    },
  };

  const result = await ensureTrafficLineApi(page as never, "78483120", {
    enabled: true,
    variants: ["flightRoundTrip", "trainRoundTrip"],
    availability: {
      endpointPlan: endpoints,
      availableVariants: ["flightRoundTrip", "trainRoundTrip"],
      unavailableVariants: {},
    },
  }, {
    itinerary: [{ spots: [{ city: "成都" }] }],
    endpointPlan: endpoints,
  });

  assert.deepEqual(new Set(saveStarts), new Set(["飞机往返", "火车往返"]));
  assert.equal(result.skipped?.some((item) => /未等到火车子产品并行启动/.test(item.reason)), false);
});

test("执行阶段保留已确认的火车配置，交由平台资源阶段判断可售性", () => {
  assert.deepEqual(
    trafficLineConfigForProduct(
      { enabled: true, variants: ["flightRoundTrip", "trainRoundTrip"] },
      { basicInfo: { meetingCity: "日喀则市", destinationCity: "日喀则" }, operations: { pickupCity: "日喀则" } },
    ),
    { enabled: true, variants: ["flightRoundTrip", "trainRoundTrip"] },
  );
});
