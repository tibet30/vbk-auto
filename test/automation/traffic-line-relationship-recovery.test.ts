import test from "node:test";
import assert from "node:assert/strict";
import { ensureTrafficLineRelationship } from "../../src/main/automation/ctrip/traffic-line/relationships.js";
import { EMPTY_VBK_SESSION_CONTEXT } from "../../src/main/infrastructure/vbk-session-request.js";
import { isUnavailableTrafficResourceFailure } from "../../src/shared/traffic-resource-status.js";

import { trainRecoveryExcludedCodes } from "../../src/main/automation/ctrip/traffic-line/helpers.js";

const target = { variant: "flightRoundTrip" as const, lineDescription: "飞机往返" };
function fixture(visibleAfter: number, productId = "79314607") {
  let reads = 0;
  let writes = 0;
  const page = {
    nativeOnly: true as const,
    evaluate: async () => { throw new Error("必须使用当前会话"); },
    vbkSessionGetText: async () => {
      reads++;
      const childList = reads >= visibleAfter ? [{ subProductId: productId, lineDescription: "飞机往返" }] : [];
      return { status: 200, text: `<script>window.__INITIAL_STATE__ = ${JSON.stringify({ childList })};</script>` };
    },
    vbkSessionFetch: async (request: { endpoint: string }) => {
      const payload = request.endpoint.endsWith("getPackageProductDetail")
        ? { generalInfoDto: {}, subLineInfoDto: {} }
        : (writes++, { subProductId: "79314607" });
      return { status: 200, payload: { ResponseStatus: { Ack: "Success" }, ...payload }, ctx: EMPTY_VBK_SESSION_CONTEXT, durationMs: 1 };
    },
  };
  return { page, reads: () => reads, writes: () => writes };
}

test("创建后先保存子产品 ID，等待延迟关系回读，只创建一次", async () => {
  const f = fixture(4);
  let checkpoint = "";
  const result = await ensureTrafficLineRelationship(f.page, "79313974", target, {
    sleep: async () => { assert.equal(checkpoint, "79314607"); },
    onCreated: id => { checkpoint = id; assert.equal(f.reads(), 1); },
  });
  assert.equal(result.productId, checkpoint);
  assert.equal(f.writes(), 1);
  assert.equal(f.reads(), 4);
});

test("恢复已保存 ID 时等待母子关系，不再创建第二个壳", async () => {
  const f = fixture(3);
  const result = await ensureTrafficLineRelationship(f.page, "79313974", target, {
    expectedChildId: "79314607", sleep: async () => {},
  });
  assert.equal(result.productId, "79314607");
  assert.equal(f.writes(), 0);
});

test("关系持续不可见时保留可恢复 ID，停止而不重复创建", async () => {
  const f = fixture(100);
  let checkpoint = "";
  await assert.rejects(() => ensureTrafficLineRelationship(f.page, "79313974", target, {
    maxReadbacks: 2, sleep: async () => {}, onCreated: id => { checkpoint = id; },
  }), /79314607.*保留已创建记录/);
  assert.equal(checkpoint, "79314607");
  assert.equal(f.writes(), 1);
});

test("已保存 ID 与唯一关系不一致时停止，不复用错误产品", async () => {
  const f = fixture(1, "99999999");
  await assert.rejects(() => ensureTrafficLineRelationship(f.page, "79313974", target, {
    expectedChildId: "79314607",
  }), /与当前母子关系不一致/);
  assert.equal(f.writes(), 0);
});

test("协议失败与真正无资源使用不同业务状态", () => {
  assert.equal(isUnavailableTrafficResourceFailure("创建飞机往返子产品后母子关系回读不一致。", "flightRoundTrip"), false);
  assert.equal(isUnavailableTrafficResourceFailure("请求超时", "trainRoundTrip"), false);
  assert.equal(isUnavailableTrafficResourceFailure("子产品资源校验后没有任何可用的多出发城市", "trainRoundTrip"), true);
});


test("异城零资源恢复保留唯一返程站，只更换抵达站", () => {
  const plan = { arrivalCity: "西安", departureCity: "汉中", resolvedAt: "now",
    train: { arrival: { code: "CN001XAY", name: "西安", resourceKey: "10" }, departure: { code: "CN001HOY", name: "汉中", resourceKey: "129" } } };
  assert.deepEqual(trainRecoveryExcludedCodes(plan, ["CN001XAY", "CN001HOY"]), ["CN001XAY"]);
  assert.deepEqual(trainRecoveryExcludedCodes({ ...plan, departureCity: "西安" }), ["CN001XAY", "CN001HOY"]);
});

test("火车候选恢复失败不会阻断飞机子产品处理", async () => {
  const { ensureTrafficLineApi } = await import("../../src/main/automation/ctrip/traffic-line/main.js");
  const f = fixture(100);
  let flightAttempted = false;
  f.page.vbkSessionFetch = async request => {
    if (request.endpoint.endsWith("getPackageProductDetail")) return {
      status: 200, payload: { ResponseStatus: { Ack: "Success" }, generalInfoDto: {}, subLineInfoDto: {} },
      ctx: EMPTY_VBK_SESSION_CONTEXT, durationMs: 1,
    } as any;
    if (request.endpoint.endsWith("saveLineInfo")) { flightAttempted = true; throw new Error("模拟飞机创建失败"); }
    throw new Error("模拟车站查询失败");
  };
  const endpointPlan = { arrivalCity: "西安", departureCity: "汉中", resolvedAt: "now",
    flight: { arrival: { code: "XIY", name: "咸阳国际机场" }, departure: { code: "HZG", name: "城固机场" } },
    train: { arrival: { code: "CN001XAY", name: "西安", resourceKey: "10" }, departure: { code: "CN001HOY", name: "汉中", resourceKey: "129" } } };
  const result = await ensureTrafficLineApi(f.page, "79313974", {
    enabled: true, variants: ["flightRoundTrip", "trainRoundTrip"],
    availability: { endpointPlan, availableVariants: ["flightRoundTrip", "trainRoundTrip"], unavailableVariants: {} },
  }, { itinerary: [{ spots: [{ city: "西安" }] }], endpointPlan, childProgress: [{ variant: "trainRoundTrip", lineDescription: "火车往返", childProductId: "79314611",
    completedStages: ["planned", "childCreated", "presentationCopied"], verified: false, skipped: true,
    failureReason: "子产品资源校验后没有任何可用的多出发城市" }] });
  assert.equal(flightAttempted, true);
  assert.equal(result.skipped?.length, 2);
});

test("车站消歧返回非法结果时有界重查，仍只接受真实候选", async () => {
  const { preflightTrafficLineEndpoints } = await import("../../src/main/automation/ctrip/traffic-line/endpoints.js");
  let selections = 0;
  const page = { nativeOnly: true as const, evaluate: async () => undefined,
    vbkSessionFetch: async (request: any) => ({ status: 200, durationMs: 1, ctx: EMPTY_VBK_SESSION_CONTEXT,
      payload: { ResponseStatus: { Ack: "Success" }, trainStations: request.body.keyword === "西安"
        ? [{ locationCode: "CN001EAY", stationName: "西安北", stationNo: 11 }, { locationCode: "CN001XXX", stationName: "西安南", stationNo: 12 }]
        : [{ locationCode: "CN001HOY", stationName: "汉中", stationNo: 129 }] } }),
  };
  const result = await preflightTrafficLineEndpoints(page, [], new Date(), async () => {
    if (++selections < 3) throw new Error("MiniMax 返回的选择结果不合法。");
    return { pickedText: "西安北", reasoning: "真实客运站候选" };
  }, { basicInfo: { destinationCity: "西安" }, operations: { trafficLine: { arrivalCity: "西安", departureCity: "汉中" } } }, ["trainRoundTrip"]);
  assert.equal(selections, 3);
  assert.equal(result.endpointPlan.train?.arrival.code, "CN001EAY");
});
