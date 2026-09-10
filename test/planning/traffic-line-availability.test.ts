import test from "node:test";
import assert from "node:assert/strict";
import { syncInitialTrafficLineAvailability } from "../../src/main/planning/traffic-line-availability.js";
import type { OrchestratorRuntime } from "../../src/main/planning/types.js";
import type { TrafficLineEndpointAvailability } from "../../src/main/automation/ctrip/traffic-line/endpoints.js";

function availability(
  variants: TrafficLineEndpointAvailability["availableVariants"],
  arrivalCity = "成都",
  departureCity = "拉萨",
): TrafficLineEndpointAvailability {
  return {
    endpointPlan: { arrivalCity, departureCity, resolvedAt: "2026-09-09T00:00:00.000Z" },
    availableVariants: variants,
    unavailableVariants: {},
  };
}

function runtimeFor(
  response: TrafficLineEndpointAvailability | null | Error,
  product: Record<string, unknown> = productWithTrafficLineRequest(),
) {
  let written: unknown;
  const runtime: OrchestratorRuntime = {
    async loadCurrentProduct() { return product; },
    async loadExistingResearchTasks() { return []; },
    async writeModule() { return { ok: true }; },
    async addResearchTask() { return "task"; },
    async loadHistory() { return []; },
    async loadAcceptedModules() { return []; },
    async resolveTrafficLineAvailability() {
      if (response instanceof Error) throw response;
      return response;
    },
    async writeResolvedTrafficLineConfig(_id, config) {
      written = config;
      return { ok: true };
    },
  };
  return { runtime, written: () => written };
}

function productWithTrafficLineRequest() {
  return {
    basicInfo: { userIdea: "含往返大交通" },
    operations: { trafficLine: { enabled: false, variants: [] } },
  };
}

test("首轮 POI 核验后，仅把接口确认可用的飞机/火车往返写入结构化字段", async () => {
  const fake = runtimeFor(availability(["flightRoundTrip", "trainRoundTrip"]));

  const result = await syncInitialTrafficLineAvailability("p", fake.runtime);

  assert.deepEqual(result, {
    status: "updated",
    config: {
      enabled: true,
      variants: ["flightRoundTrip", "trainRoundTrip"],
      availability: availability(["flightRoundTrip", "trainRoundTrip"]),
    },
  });
  assert.deepEqual(fake.written(), {
    enabled: true,
    variants: ["flightRoundTrip", "trainRoundTrip"],
    availability: availability(["flightRoundTrip", "trainRoundTrip"]),
  });
});

test("一类交通候选未确认时，保留另一类已由接口确认的配置", async () => {
  const fake = runtimeFor(availability(["flightRoundTrip"]));

  await syncInitialTrafficLineAvailability("p", fake.runtime);

  assert.deepEqual(fake.written(), {
    enabled: true,
    variants: ["flightRoundTrip"],
    availability: availability(["flightRoundTrip"]),
  });
});

test("目的地往返的端点接口确认火车后，保留火车配置供平台资源阶段核验", async () => {
  const fake = runtimeFor(availability(["flightRoundTrip", "trainRoundTrip"], "成都", "成都"));

  await syncInitialTrafficLineAvailability("p", fake.runtime);

  assert.deepEqual(fake.written(), {
    enabled: true,
    variants: ["flightRoundTrip", "trainRoundTrip"],
    availability: availability(["flightRoundTrip", "trainRoundTrip"], "成都", "成都"),
  });
});

test("首次接口判定保留已明确指定的端点，只为未指定端点使用目的地默认值", async () => {
  const fake = runtimeFor(
    availability(["flightRoundTrip"], "拉萨", "日喀则"),
    { operations: { trafficLine: { enabled: false, variants: [], arrivalCity: "拉萨" } } },
  );

  await syncInitialTrafficLineAvailability("p", fake.runtime);

  assert.deepEqual(fake.written(), {
    enabled: true,
    variants: ["flightRoundTrip"],
    arrivalCity: "拉萨",
    availability: availability(["flightRoundTrip"], "拉萨", "日喀则"),
  });
});

test("接口或 POI 城市未确认时保持默认关闭，不凭失败结果猜测大交通", async () => {
  const fake = runtimeFor(new Error("候选接口超时"));

  const result = await syncInitialTrafficLineAvailability("p", fake.runtime);

  assert.deepEqual(result, { status: "skipped", reason: "unconfirmed" });
  assert.equal(fake.written(), undefined);
});

test("不覆盖已经明确配置的大交通", async () => {
  const fake = runtimeFor(
    availability(["trainRoundTrip"]),
    { operations: { trafficLine: { enabled: true, variants: ["flightRoundTrip"] } } },
  );

  const result = await syncInitialTrafficLineAvailability("p", fake.runtime);

  assert.deepEqual(result, { status: "skipped", reason: "alreadyConfigured" });
  assert.equal(fake.written(), undefined);
});

test("机场消歧超时只保留已确认火车，并在下次规划重新核验飞机", async () => {
  const partial = availability(["trainRoundTrip"], "日喀则", "日喀则");
  partial.endpointPlan.train = {
    arrival: { code: "CN001RKO", name: "日喀则", resourceKey: "92" },
    departure: { code: "CN001RKO", name: "日喀则", resourceKey: "92" },
  };
  partial.unavailableVariants.flightRoundTrip = "MiniMax 响应超时，请重试。";
  const refreshed = availability(["flightRoundTrip", "trainRoundTrip"], "日喀则", "日喀则");
  refreshed.endpointPlan.flight = {
    arrival: { code: "RKZ", name: "和平机场" },
    departure: { code: "RKZ", name: "和平机场" },
  };
  refreshed.endpointPlan.train = partial.endpointPlan.train;
  const fake = runtimeFor(
    refreshed,
    {
      operations: {
        trafficLine: {
          enabled: true,
          variants: ["trainRoundTrip"],
          availability: partial,
        },
      },
    },
  );

  const result = await syncInitialTrafficLineAvailability("p", fake.runtime);

  assert.deepEqual(result, {
    status: "updated",
    config: {
      enabled: true,
      variants: ["flightRoundTrip", "trainRoundTrip"],
      availability: refreshed,
    },
  });
  assert.deepEqual(fake.written(), result.config);
});

test("未明确要求大交通时也默认探测站点并创建可用交通子产品配置", async () => {
  const fake = runtimeFor(
    availability(["flightRoundTrip", "trainRoundTrip"], "日喀则", "日喀则"),
    {
      basicInfo: {
        userIdea: "D1、火车站接-帕拉庄园-住日喀则\nD2、扎什伦布寺--送火车",
      },
      operations: { trafficLine: { enabled: false, variants: [] } },
    },
  );

  const result = await syncInitialTrafficLineAvailability("p", fake.runtime);

  assert.deepEqual(result, {
    status: "updated",
    config: {
      enabled: true,
      variants: ["flightRoundTrip", "trainRoundTrip"],
      availability: availability(["flightRoundTrip", "trainRoundTrip"], "日喀则", "日喀则"),
    },
  });
  assert.deepEqual(fake.written(), result.config);
});
