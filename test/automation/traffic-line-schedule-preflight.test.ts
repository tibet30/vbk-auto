import test from "node:test";
import assert from "node:assert/strict";
import {
  parseCtripFlightAvailability,
  parseCtripTrainAvailability,
  preflightTrafficLineSchedules,
} from "../../src/main/automation/ctrip/traffic-line/schedule-preflight.ts";

const product = {
  commercial: { inventory: { startDate: "2026-09-09", endDate: "2027-09-09" } },
};

const availability = {
  endpointPlan: {
    arrivalCity: "日喀则",
    departureCity: "日喀则",
    resolvedAt: "2026-09-09T00:00:00.000Z",
    flight: { arrival: { code: "RKZ", name: "和平机场" }, departure: { code: "RKZ", name: "和平机场" } },
    train: {
      arrival: { code: "CN001RKO", name: "日喀则", resourceKey: "92" },
      departure: { code: "CN001RKO", name: "日喀则", resourceKey: "92" },
    },
  },
  availableVariants: ["flightRoundTrip", "trainRoundTrip"] as const,
  unavailableVariants: {},
};

const cityGroups = [
  { category: "热门", departureCities: [
    { cityId: 1, cityName: "北京" }, { cityId: 41, cityName: "拉萨" }, { cityId: 92, cityName: "日喀则" },
  ] },
  { category: "B", departureCities: [{ cityId: 1, cityName: "北京", hasAirport: true, hasTrain: true }] },
  { category: "L", departureCities: [{ cityId: 41, cityName: "拉萨", hasAirport: true, hasTrain: true }] },
  { category: "R", departureCities: [{ cityId: 92, cityName: "日喀则", hasAirport: true, hasTrain: true }] },
];

test("产品准备阶段只有双向代表日期班次通过的方式进入子产品计划", async () => {
  const result = await preflightTrafficLineSchedules({
    page: {} as any,
    availability: availability as any,
    product,
    now: new Date("2026-09-09T10:00:00+08:00"),
    dependencies: {
      loadCityGroups: async () => cityGroups,
      searchOriginAirports: async () => [{ type: "air", id: "PEK", code: "PEK", name: "北京首都国际机场", raw: {} }],
      fetchHtml: async (url) => url.includes("flights.ctrip.com") ? '\\"flightNo\\":\\"CA1234' : "共0车次",
    },
  });

  assert.deepEqual(result.availableVariants, ["flightRoundTrip"]);
  assert.equal(result.scheduleChecks?.flightRoundTrip?.status, "available");
  assert.equal(result.scheduleChecks?.flightRoundTrip?.matchedOriginCity, "北京");
  assert.equal(result.scheduleChecks?.trainRoundTrip?.status, "unavailable");
  assert.equal(result.scheduleChecks?.trainRoundTrip?.checkedDates.length, 3);
  assert.equal(result.scheduleChecks?.trainRoundTrip?.checkedCityCount, 2);
});

test("查询协议异常是暂不可确认，不会伪装成交通方式不可用", async () => {
  const result = await preflightTrafficLineSchedules({
    page: {} as any,
    availability: { ...availability, availableVariants: ["trainRoundTrip"] } as any,
    product,
    now: new Date("2026-09-09T10:00:00+08:00"),
    dependencies: { loadCityGroups: async () => cityGroups, fetchHtml: async () => "登录后查看" },
  });

  assert.deepEqual(result.availableVariants, []);
  assert.equal(result.scheduleChecks?.trainRoundTrip?.status, "unconfirmed");
  assert.match(result.unavailableVariants.trainRoundTrip ?? "", /未确认/);
});

test("携程航班和火车页面只接受明确可识别的班次结论", () => {
  assert.equal(parseCtripFlightAvailability('\\"flightNo\\":\\"TV9939'), true);
  assert.equal(parseCtripFlightAvailability("暂无可售航班"), false);
  assert.throws(() => parseCtripFlightAvailability("登录页"), /未返回可识别/);
  assert.equal(parseCtripTrainAvailability("成都-拉萨（共 1 车次）"), true);
  assert.equal(parseCtripTrainAvailability("共0车次"), false);
  assert.equal(parseCtripTrainAvailability(
    '<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"initialState":{"trainSearchInfo":{"trainInfoList":[{"trainNumber":"C885"}]}}}}}</script>',
  ), true);
});
