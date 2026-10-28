import test from "node:test";
import assert from "node:assert/strict";

import { applyRequiredPoiRiskPlans, currentTrafficLineTourInfoId, mergeTrafficNodes, verifyTrafficNodes, waitForTrafficLineItineraryReadback } from "../../src/main/automation/ctrip/traffic-line/itinerary.ts";

test("行程交通按 activeType 语义合并，不覆盖中间 POI，单日补齐双节点", () => {
  const endpoints = {
    arrivalCity: "日喀则",
    departureCity: "日喀则",
    resolvedAt: "2026-09-11T00:00:00.000Z",
    flight: {
      arrival: { code: "RKZ", name: "和平机场" },
      departure: { code: "RKZ", name: "和平机场" },
    },
  };
  const firstTransport = { activeType: { key: 2, name: "航班" }, title: "去程" };
  const lastTransport = { activeType: { key: 2, name: "航班" }, title: "回程" };
  const merged = mergeTrafficNodes({
    tourDailyDescriptions: [
      { tourDailyInfos: [{ activeType: { key: 3, name: "景点" }, tourDailyPois: [{ poi: { poiId: 1 } }] }] },
      { tourDailyInfos: [{ activeType: { key: 3, name: "景点" }, tourDailyPois: [{ poi: { poiId: 2 } }] }] },
    ],
  }, firstTransport, lastTransport, "flightRoundTrip", endpoints);
  const days = merged.tourDailyDescriptions as Array<{ tourDailyInfos: Array<{ activeType: { key: number }; tourDailyPois?: unknown[] }> }>;
  assert.equal(days[0]?.tourDailyInfos[0]?.activeType.key, 2);
  assert.equal(days[1]?.tourDailyInfos.at(-1)?.activeType.key, 2);
  assert.equal(days[0]?.tourDailyInfos[1]?.tourDailyPois?.length, 1);
  assert.equal(verifyTrafficNodes(merged, "flightRoundTrip"), 2);

  const oneDay = mergeTrafficNodes({ tourDailyDescriptions: [{ tourDailyInfos: [] }] }, firstTransport, lastTransport, "flightRoundTrip", endpoints);
  assert.equal(verifyTrafficNodes(oneDay, "flightRoundTrip"), 2);
});

test("行程交通用页面源替换不完整的边交通节点", () => {
  const firstTransport = {
    activeType: { key: 2, name: "航班" }, title: "去程",
    tourDailyPackageFlights: [{ flightNo: "CA1234" }],
  };
  const lastTransport = {
    activeType: { key: 2, name: "航班" }, title: "回程",
    tourDailyPackageFlights: [{ flightNo: "CA4321" }],
  };
  const merged = mergeTrafficNodes({
    tourDailyDescriptions: [
      { tourDailyInfos: [
        { activeType: { key: 2, name: "航班" }, tourDailyFlights: [], tourDailyPackageFlights: [] },
        { activeType: { key: 3, name: "景点" }, tourDailyPois: [{ poi: { poiId: 1 } }] },
      ] },
      { tourDailyInfos: [
        { activeType: { key: 3, name: "景点" }, tourDailyPois: [{ poi: { poiId: 2 } }] },
        { activeType: { key: 2, name: "航班" }, tourDailyFlights: [] },
      ] },
    ],
  }, firstTransport, lastTransport, "flightRoundTrip");
  const days = merged.tourDailyDescriptions as Array<{ tourDailyInfos: Array<Record<string, any>> }>;
  assert.equal(days[0]?.tourDailyInfos[0]?.title, "去程");
  assert.equal(days[0]?.tourDailyInfos[0]?.tourDailyPackageFlights[0]?.flightNo, "CA1234");
  assert.equal(days[1]?.tourDailyInfos.at(-1)?.title, "回程");
  assert.equal(days[1]?.tourDailyInfos.at(-1)?.tourDailyPackageFlights[0]?.flightNo, "CA4321");
  assert.equal(verifyTrafficNodes(merged, "flightRoundTrip"), 2);
});

test("飞机交通节点在资源提交前补齐航班信息卡片", () => {
  const endpoints = {
    arrivalCity: "日喀则",
    departureCity: "日喀则",
    resolvedAt: "2026-09-11T00:00:00.000Z",
    flight: {
      arrival: { code: "RKZ", name: "和平机场" },
      departure: { code: "RKZ", name: "和平机场" },
    },
  };
  const merged = mergeTrafficNodes({
    tourDailyDescriptions: [
      { tourDailyInfos: [{ activeType: { key: 3, name: "景点" }, tourDailyPois: [{ poi: { poiId: 1 } }] }] },
      { tourDailyInfos: [{ activeType: { key: 3, name: "景点" }, tourDailyPois: [{ poi: { poiId: 2 } }] }] },
    ],
  }, { activeType: { key: 2, name: "航班" }, title: "去程" }, { activeType: { key: 2, name: "航班" }, title: "回程" }, "flightRoundTrip", endpoints);

  const days = merged.tourDailyDescriptions as Array<{ tourDailyInfos: Array<Record<string, any>> }>;
  const outbound = days[0]!.tourDailyInfos[0]!;
  const inbound = days[1]!.tourDailyInfos.at(-1)!;
  assert.equal(outbound.tourDailyPackageFlights[0].departureLocation.name, "出发地");
  assert.equal(outbound.tourDailyPackageFlights[0].arriveAirports[0].code, "RKZ");
  assert.equal(inbound.tourDailyPackageFlights[0].departureAirports[0].code, "RKZ");
  assert.equal(inbound.tourDailyPackageFlights[0].arriveLocation.name, "目的地");
  assert.equal(outbound.tourDailyFlights[0].flight.arriveAirport.code, "RKZ");
  assert.equal(inbound.tourDailyFlights[0].flight.departureAirport.code, "RKZ");
  assert.equal(verifyTrafficNodes(merged, "flightRoundTrip"), 2);
});

test("飞机交通节点已存在但缺卡片时会按端点重建双形态航班卡片", () => {
  const endpoints = {
    arrivalCity: "日喀则",
    departureCity: "日喀则",
    resolvedAt: "2026-09-11T00:00:00.000Z",
    flight: {
      arrival: { code: "RKZ", name: "和平机场" },
      departure: { code: "RKZ", name: "和平机场" },
    },
  };
  const merged = mergeTrafficNodes({
    tourDailyDescriptions: [
      { tourDailyInfos: [{ activeType: { key: 2, name: "航班" }, tourDailyFlights: [] }] },
      { tourDailyInfos: [{ activeType: { key: 2, name: "航班" }, tourDailyFlights: [] }] },
    ],
  }, { activeType: { key: 2, name: "航班" }, title: "去程" }, { activeType: { key: 2, name: "航班" }, title: "回程" }, "flightRoundTrip", endpoints);

  const days = merged.tourDailyDescriptions as Array<{ tourDailyInfos: Array<Record<string, any>> }>;
  assert.equal(days[0]!.tourDailyInfos[0]!.tourDailyPackageFlights[0].arriveAirports[0].code, "RKZ");
  assert.equal(days[0]!.tourDailyInfos[0]!.tourDailyPackageFlights[0].departureLocation.name, "出发地");
  assert.equal(days[0]!.tourDailyInfos[0]!.tourDailyFlights[0].flight.arriveAirport.code, "RKZ");
  assert.equal(days[1]!.tourDailyInfos[0]!.tourDailyPackageFlights[0].departureAirports[0].code, "RKZ");
  assert.equal(days[1]!.tourDailyInfos[0]!.tourDailyPackageFlights[0].arriveLocation.name, "目的地");
  assert.equal(days[1]!.tourDailyInfos[0]!.tourDailyFlights[0].flight.departureAirport.code, "RKZ");
  assert.equal(verifyTrafficNodes(merged, "flightRoundTrip"), 2);
});

test("飞机交通节点已有部分包卡片时会补齐平台要求的出发地和目的地占位", () => {
  const endpoints = {
    arrivalCity: "日喀则",
    departureCity: "日喀则",
    resolvedAt: "2026-09-11T00:00:00.000Z",
    flight: {
      arrival: { code: "RKZ", name: "和平机场" },
      departure: { code: "RKZ", name: "和平机场" },
    },
  };
  const merged = mergeTrafficNodes({
    tourDailyDescriptions: [
      { tourDailyInfos: [{ activeType: { key: 2, name: "航班" }, tourDailyPackageFlights: [{ arriveAirports: [{ code: "RKZ" }] }] }] },
      { tourDailyInfos: [{ activeType: { key: 2, name: "航班" }, tourDailyPackageFlights: [{ departureAirports: [{ code: "RKZ" }] }] }] },
    ],
  }, { activeType: { key: 2, name: "航班" }, title: "去程" }, { activeType: { key: 2, name: "航班" }, title: "回程" }, "flightRoundTrip", endpoints);

  const days = merged.tourDailyDescriptions as Array<{ tourDailyInfos: Array<Record<string, any>> }>;
  assert.equal(days[0]!.tourDailyInfos[0]!.tourDailyPackageFlights[0].departureLocation.name, "出发地");
  assert.equal(days[1]!.tourDailyInfos[0]!.tourDailyPackageFlights[0].arriveLocation.name, "目的地");
  assert.equal(days[1]!.tourDailyInfos[0]!.tourDailyFlights[0].flight.departureAirport.code, "RKZ");
  assert.equal(verifyTrafficNodes(merged, "flightRoundTrip"), 2);
});

test("飞机行程回读缺少航班信息卡片时不能视为完成", () => {
  assert.throws(() => verifyTrafficNodes({
    tourDailyDescriptions: [
      { tourDailyInfos: [{ activeType: { key: 2, name: "航班" }, tourDailyFlights: [] }] },
      { tourDailyInfos: [{ activeType: { key: 2, name: "航班" }, tourDailyFlights: [] }] },
    ],
  }, "flightRoundTrip"), /缺少首日或末日目标交通节点/);
});

test("资源段配置不能代替平台要求的航班卡片，恢复时补齐首末日", () => {
  const tour = {
    tourDailyDescriptions: [
      { tourDailyInfos: [{ activeType: { key: 2, name: "航班" }, useSegmentConfig: true, tourDailyFlights: [], tourDailyPackageFlights: [] }] },
      { tourDailyInfos: [{ activeType: { key: 2, name: "航班" }, useSegmentConfig: true, tourDailyFlights: [], tourDailyPackageFlights: [] }] },
    ],
  };
  assert.throws(() => verifyTrafficNodes(tour, "flightRoundTrip"), /缺少首日或末日目标交通节点/);
  const endpoints = { arrivalCity: "西安", departureCity: "汉中", resolvedAt: "2026-10-08",
    flight: { arrival: { code: "XIY", name: "咸阳国际机场" }, departure: { code: "HZG", name: "城固机场" } } };
  const source = { activeType: { key: 2, name: "航班" }, useSegmentConfig: true };
  const merged = mergeTrafficNodes(tour, source, source, "flightRoundTrip", endpoints);
  assert.equal(verifyTrafficNodes(merged, "flightRoundTrip"), 2);
  const days = merged.tourDailyDescriptions as Array<{ tourDailyInfos: Array<Record<string, any>> }>;
  assert.equal(days[0]!.tourDailyInfos[0]!.useSegmentConfig, false);
  assert.equal(days[0]!.tourDailyInfos[0]!.tourDailyPackageFlights[0].arriveAirports[0].code, "XIY");
  assert.equal(days[1]!.tourDailyInfos[0]!.tourDailyPackageFlights[0].departureAirports[0].code, "HZG");
});

test("火车交通节点在资源提交前补齐火车信息卡片", () => {
  const endpoints = {
    arrivalCity: "日喀则",
    departureCity: "日喀则",
    resolvedAt: "2026-09-11T00:00:00.000Z",
    train: {
      arrival: { code: "CN001RKO", name: "日喀则", resourceKey: "92" },
      departure: { code: "CN001RKO", name: "日喀则", resourceKey: "92" },
    },
  };
  const merged = mergeTrafficNodes({
    tourDailyDescriptions: [
      { tourDailyInfos: [{ activeType: { key: 3, name: "景点" }, tourDailyPois: [{ poi: { poiId: 1 } }] }] },
      { tourDailyInfos: [{ activeType: { key: 3, name: "景点" }, tourDailyPois: [{ poi: { poiId: 2 } }] }] },
    ],
  }, { activeType: { key: 14, name: "火车" }, title: "去程" }, { activeType: { key: 14, name: "火车" }, title: "回程" }, "trainRoundTrip", endpoints);

  const days = merged.tourDailyDescriptions as Array<{ tourDailyInfos: Array<Record<string, any>> }>;
  const outbound = days[0]!.tourDailyInfos[0]!;
  const inbound = days[1]!.tourDailyInfos.at(-1)!;
  assert.equal(outbound.tourDailyPackageTrains[0].arriveTrainStations[0].stationName, "日喀则");
  assert.equal(inbound.tourDailyPackageTrains[0].departureTrainStations[0].stationName, "日喀则");
  assert.equal(verifyTrafficNodes(merged, "trainRoundTrip"), 2);
});

test("火车行程回读缺少火车信息卡片时不能视为完成", () => {
  assert.throws(() => verifyTrafficNodes({
    tourDailyDescriptions: [
      { tourDailyInfos: [{ activeType: { key: 14, name: "火车" }, tourDailyTrains: [] }] },
      { tourDailyInfos: [{ activeType: { key: 14, name: "火车" }, tourDailyTrains: [] }] },
    ],
  }, "trainRoundTrip"), /缺少首日或末日目标交通节点/);
});

test("行程保存后按同一绑定 ID 有界轮询，直到交通节点正式可见", async () => {
  let calls = 0;
  const waits: number[] = [];
  const result = await waitForTrafficLineItineraryReadback(async () => {
    calls += 1;
    return calls === 1
      ? { tourInfoId: "tour-9", tourInfo: { tourDailyDescriptions: [{ tourDailyInfos: [] }] } }
      : {
          tourInfoId: "tour-9",
          tourInfo: {
            tourDailyDescriptions: [
              { tourDailyInfos: [{ activeType: { key: 2, name: "航班" }, tourDailyPackageFlights: [{ arriveAirports: [{ code: "RKZ" }] }] }] },
              { tourDailyInfos: [{ activeType: { key: 2, name: "航班" }, tourDailyPackageFlights: [{ departureAirports: [{ code: "RKZ" }] }] }] },
            ],
          },
        };
  }, "tour-9", "flightRoundTrip", {
    maxPolls: 2,
    sleep: async (milliseconds) => { waits.push(milliseconds); },
  });
  assert.deepEqual(result, { days: 2, transportNodes: 2 });
  assert.deepEqual(waits, [500]);
});

test("行程只读轮询不能用其它 tourInfoId 的节点冒充当前保存结果", async () => {
  await assert.rejects(() => waitForTrafficLineItineraryReadback(async () => ({
    tourInfoId: "stale-tour",
    tourInfo: { tourDailyDescriptions: [{ tourDailyInfos: [{ activeType: { key: 2 } }] }] },
  }), "saved-tour", "flightRoundTrip", { maxPolls: 1 }), /当前绑定行程 ID=stale-tour/);
});

test("交通子产品以当前 tourInfoId 为准，旧 audit 行程不能冒充当前绑定", () => {
  assert.equal(currentTrafficLineTourInfoId({
    tourInfo: {
      tourInfoId: "current-without-nodes",
      auditTourInfoId: "old-audit-with-nodes",
      previewTourInfoId: "preview",
    },
    tourInfoId: "old-audit-with-nodes",
    isNew: false,
  }), "current-without-nodes");
  assert.equal(currentTrafficLineTourInfoId({
    tourInfo: { tourInfoId: 0, auditTourInfoId: "old-audit-with-nodes" },
    tourInfoId: "old-audit-with-nodes",
    isNew: false,
  }), "");
});
test("交通子产品保存行程时按费用口径唯一补齐风险 POI 备选方案", () => {
  const source = {
    tourDailyDescriptions: [{ tourDailyInfos: [{ costInclude: false, tourDailyPois: [{
      riskPlanCode: "",
      riskPlanDesc: "",
      poi: {
        poiId: 75682,
        poiName: "秦始皇帝陵博物院(兵马俑)",
        isRisk: true,
        riskPlanList: [
          { riskPlanCode: "75682-T-1", riskPlanDesc: "含票方案", costInclude: "T" },
          { riskPlanCode: "75682-F-1", riskPlanDesc: "不含票方案", costInclude: "F" },
        ],
      },
    }] }] }],
  };
  const result = applyRequiredPoiRiskPlans(source as any);
  const dailyPoi = (result.tourDailyDescriptions as any)[0].tourDailyInfos[0].tourDailyPois[0];
  assert.equal(dailyPoi.riskPlanCode, "75682-F-1");
  assert.equal(dailyPoi.riskPlanDesc, "不含票方案");
  assert.equal((source.tourDailyDescriptions as any)[0].tourDailyInfos[0].tourDailyPois[0].riskPlanCode, "");
});

test("风险 POI 备选方案不能唯一确认时安全阻断", () => {
  assert.throws(() => applyRequiredPoiRiskPlans({
    tourDailyDescriptions: [{ tourDailyInfos: [{ costInclude: false, tourDailyPois: [{
      poi: { poiId: 1, poiName: "风险景点", isRisk: true, riskPlanList: [
        { riskPlanCode: "A", riskPlanDesc: "方案一", costInclude: "T" },
        { riskPlanCode: "B", riskPlanDesc: "方案二", costInclude: "A" },
      ] },
    }] }] }],
  }), /无法唯一确认备选方案/);
});

test("同一平台适用口径有多个风险方案时采用 VBK 默认优先项", () => {
  const result = applyRequiredPoiRiskPlans({
    tourDailyDescriptions: [{ tourDailyInfos: [{ costInclude: false, tourDailyPois: [{
      poi: { poiName: "陕西历史博物馆", isRisk: true, riskPlanList: [
        { riskPlanCode: "75684-A-1", riskPlanDesc: "平台首选方案", costInclude: "A" },
        { riskPlanCode: "75684-A-2", riskPlanDesc: "平台次选方案", costInclude: "A" },
      ] },
    }] }] }],
  });
  const dailyPoi = (result.tourDailyDescriptions as any)[0].tourDailyInfos[0].tourDailyPois[0];
  assert.equal(dailyPoi.riskPlanCode, "75684-A-1");
});
