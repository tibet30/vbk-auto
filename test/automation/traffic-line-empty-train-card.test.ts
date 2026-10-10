import test from "node:test";
import assert from "node:assert/strict";
import { mergeTrafficNodes, verifyTrafficNodes } from "../../src/main/automation/ctrip/traffic-line/itinerary.js";

test("empty train nodes using resource configuration receive explicit endpoint cards", () => {
  const endpoints = {
    arrivalCity: "西安", departureCity: "汉中", resolvedAt: "2026-10-09",
    train: {
      arrival: { code: "CN001XAY", name: "西安", resourceKey: "10" },
      departure: { code: "CN001HOY", name: "汉中", resourceKey: "129" },
    },
  };
  const source = {
    activeType: { key: 14, name: "火车" }, useSegmentConfig: true,
    tourDailyPackageTrains: [], tourDailyTrains: [],
  };
  const tour = { tourDailyDescriptions: [
    { tourDailyInfos: [structuredClone(source)] },
    { tourDailyInfos: [structuredClone(source)] },
  ] };
  assert.throws(() => verifyTrafficNodes(tour, "trainRoundTrip"), /缺少首日或末日/);
  const merged = mergeTrafficNodes(tour, source, source, "trainRoundTrip", endpoints);
  const days = merged.tourDailyDescriptions as Array<{ tourDailyInfos: Array<Record<string, any>> }>;
  assert.equal(verifyTrafficNodes(merged, "trainRoundTrip"), 2);
  assert.ok(days.every(day => day.tourDailyInfos[0]!.useSegmentConfig === false));
  assert.equal(days[0]!.tourDailyInfos[0]!.tourDailyPackageTrains[0].arriveTrainStations[0].stationName, "西安");
  assert.equal(days[1]!.tourDailyInfos[0]!.tourDailyPackageTrains[0].departureTrainStations[0].stationName, "汉中");
  assert.equal(source.useSegmentConfig, true);
  assert.deepEqual(source.tourDailyPackageTrains, []);
});
