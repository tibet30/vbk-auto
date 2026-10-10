import test from "node:test";
import assert from "node:assert/strict";
import { EMPTY_VBK_SESSION_CONTEXT } from "../../src/main/infrastructure/vbk-session-request.js";
import { readSegmentSubmitState, waitForSegmentSubmit } from "../../src/main/automation/ctrip/traffic-line/segment-submit.js";
import { verifyValidatedDepartureCityReadback } from "../../src/main/automation/ctrip/traffic-line/segment-departure-cities.js";
import { trafficLineResourceCheckDates } from "../../src/main/automation/ctrip/traffic-line/segments.js";
import { isUnavailableTrafficResourceFailure } from "../../src/shared/traffic-resource-status.js";
import { trafficLineFailureProgress } from "../../src/main/automation/ctrip/traffic-line/child-failure.js";
import { trafficLineChildShouldBeSkipped } from "../../src/main/automation/ctrip/traffic-line/helpers.js";

function pageFor(payload: Record<string, unknown>) {
  let requests = 0;
  return { calls: () => requests, page: { nativeOnly: true as const,
    evaluate: async () => { throw new Error("native request required"); },
    vbkSessionFetch: async () => { requests++; return { status: 200, payload: { ResponseStatus: { Ack: "Success" }, ...payload }, durationMs: 1, ctx: EMPTY_VBK_SESSION_CONTEXT }; } } };
}

test("真实F回执中的酒店不可订和提前预订错误保留日期原因，不能认成无机票", async () => {
  const fixture = pageFor({ result: "F", checkSegmentResultCities: [{ city: { cityId: 32 }, errors: [
    { schedule: "2026-10-07", message: "提前预订天数不正确" },
    { schedule: "2027-04-07", message: "行程段3：酒店不可订Message:hbu return empty,logid:private" },
  ] }] });
  const state = await readSegmentSubmitState(fixture.page, "79344930");
  assert.equal(state.status, "failed");
  if (state.status === "failed") {
    assert.match(state.message, /2027-04-07：行程段3：酒店不可订/);
    assert.doesNotMatch(state.message, /logid/);
  }
  await assert.rejects(waitForSegmentSubmit(fixture.page, "79344930", { maxPolls: 1 }), error => {
    assert.equal(isUnavailableTrafficResourceFailure(String(error)), false);
    return /预订规则或地接资源问题/.test(String(error));
  });
});

test("真实T回执的全部城市移除只有与本轮提交集合一致时才认定全部拒绝", async () => {
  const fixture = pageFor({ result: "T", messages: ["产品出发城市中有2个城市不符合系统火车票校验,系统自动移除了。"] });
  assert.deepEqual(await waitForSegmentSubmit(fixture.page, "train", { submittedCityIds: ["1", "2"], maxPolls: 1 }), ["1", "2"]);
  assert.deepEqual(await waitForSegmentSubmit(fixture.page, "train", { submittedCityIds: ["1", "2", "3"], maxPolls: 1 }), []);
});

test("正式出发城市缺字段、空列表、未知城市或无效ID都保留为待核验", () => {
  for (const departure of [{}, { departureCities: [] }, { departureCities: [{ cityId: 99 }] }, { departureCities: [{ cityName: "北京" }] }]) {
    assert.throws(() => verifyValidatedDepartureCityReadback({ productSegments: { productDepartureCity: departure } }, [{ cityId: 1 }]), error => {
      assert.equal(isUnavailableTrafficResourceFailure(String(error)), false);
      return true;
    });
  }
});

test("班期探测遵守提前预订与库存边界，不使用今天或一年后的不可订日期", () => {
  const product = { operations: { bookingControls: { advanceBooking: { days: 7, time: "18:00" } } }, commercial: { inventory: { startDate: "2026-10-07", endDate: "2027-10-06" } } };
  assert.deepEqual(trafficLineResourceCheckDates(product, new Date("2026-10-07T16:00:00+08:00")), ["2026-10-15", "2026-10-16", "2026-10-17"]);
  product.commercial.inventory.endDate = "2026-10-14";
  assert.deepEqual(trafficLineResourceCheckDates(product, new Date("2026-10-07T16:00:00+08:00")), []);
});

test("子产品协议失败保留可重试阶段，历史错误skipped标记不阻止恢复", () => {
  const previous = { variant: "flightRoundTrip" as const, lineDescription: "飞机往返", completedStages: ["planned", "stationsResolved", "childCreated", "presentationCopied"] as const, verified: false };
  const progress = trafficLineFailureProgress({ ...previous, completedStages: [...previous.completedStages] }, "酒店不可订");
  assert.equal(progress.skipped, false);
  assert.equal(progress.failedStage, "resourcesSaved");
  assert.equal(trafficLineChildShouldBeSkipped({ ...progress, skipped: true }), false);
  assert.equal(trafficLineFailureProgress(progress, "VBK 校验后没有任何可用的多出发城市").skipped, true);
});

test("交通班期已核验且正式用车绑定完整时，后续用车门只读且不重提90天后的班期", async () => {
  const { ensureTrafficLineVehicleBinding } = await import("../../src/main/automation/ctrip/traffic-line/helpers.js");
  const calls: string[] = [];
  const page = { nativeOnly: true as const, evaluate: async () => { throw new Error("native only"); },
    vbkSessionFetch: async (request: { endpoint: string }) => {
      calls.push(request.endpoint);
      assert.ok(request.endpoint.endsWith("getSegments"), "已经正式落库时不能创建草稿或重提班期");
      return { status: 200, payload: { ResponseStatus: { Ack: "Success" }, productSegments: { segments: [
        { segmentBase: { segmentNumber: 1, departureCity: { cityId: 0, cityName: "多出发" }, destinationCity: { cityId: 10, cityName: "西安" } } },
        { segmentBase: { segmentNumber: 2, departureCity: { cityId: 10, cityName: "西安" }, destinationCity: { cityId: 10, cityName: "西安" } }, segmentResourceGroups: [{ resourceGroupId: 2207115 }] },
      ] } }, durationMs: 1, ctx: EMPTY_VBK_SESSION_CONTEXT };
    } };
  await ensureTrafficLineVehicleBinding(page, "79344930", { sales: { productForm: "privateTour" }, operations: { vehicleResource: { resourceGroupId: 2207115, resourceGroupName: "用车" } } });
  assert.equal(calls.length, 1);
});
