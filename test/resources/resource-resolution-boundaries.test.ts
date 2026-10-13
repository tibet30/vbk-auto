import test from "node:test";
import assert from "node:assert/strict";
import { createHotelCandidateResolver } from "../../src/main/infrastructure/ctrip-hotel-search/resolve.js";
import { matchVehicleResource } from "../../src/main/operations/vehicle-resource/matching.js";
import { buildVehicleResourceQuery } from "../../src/main/operations/vehicle-resource.js";
import { queryPoi } from "../../src/main/planning/poi-enrichment/query.js";
import type { OrchestratorRuntime } from "../../src/main/planning/types.js";
import { firstHotelResource, hotelResourceQuery, resolveHotelResource } from "../../src/main/operations/hotel-resource.js";

function hotelProvider(calls: number[], mode: "empty" | "network" = "empty"): typeof fetch {
  return async input => {
    const url = String(input);
    if (url.includes("gaHotelSearchEngine")) return Response.json({ Response: { searchResults: [
      { id: "1", cityId: 1, cityName: "成都", word: "成都人民政府", gLat: 30.6, gLon: 104.0 },
    ] } });
    const grade = Number(new URL(url).searchParams.get("listFilters")?.match(/16~(\d)/)?.[1] ?? 0);
    calls.push(grade);
    if (mode === "network") return new Response("offline", { status: 503 });
    return new Response(`<script>self.__next_f.push(${JSON.stringify([1, JSON.stringify({ initListData: { hotelList: [] } })])})</script>`);
  };
}

test("逐日降档许可只对明确允许的日期生效，遗漏日期不默认授权", async () => {
  const calls: number[] = [];
  const resolve = createHotelCandidateResolver(hotelProvider(calls));
  const days = [1, 2].map(day => ({ day, hotel: "成都当地3钻酒店" }));
  const original = structuredClone(days);
  await assert.rejects(resolve(days, "成都", 2, "当地3钻酒店", () => {}, undefined,
    new Map([[1, true]])), /第 1 天住宿.*第 2 天住宿/s);
  assert.deepEqual(calls, [3, 2, 1, 0, 3]);
  assert.deepEqual(days, original, "查询和回填不能修改输入行程");
});

test("显式拒绝降档和网络失败均不查询下一档，注入查询器不改全局 fetch", async () => {
  const originalFetch = globalThis.fetch;
  for (const mode of ["empty", "network"] as const) {
    const calls: number[] = [];
    const resolve = createHotelCandidateResolver(hotelProvider(calls, mode));
    await assert.rejects(resolve([{ day: 1, hotel: "成都当地3钻酒店" }], "成都", 1,
      "当地3钻酒店", undefined, undefined, mode === "empty" ? new Map([[1, false]]) : true));
    assert.deepEqual(calls, [3]);
  }
  assert.equal(globalThis.fetch, originalFetch);
});

test("车辆精准查询失败向上抛出，不能当作无匹配而清理现有绑定", async () => {
  const queries: string[] = [];
  await assert.rejects(matchVehicleResource(buildVehicleResourceQuery({ city: "成都" }), 1000,
    async query => { queries.push(query); throw new Error("账号查询被拒绝"); }), /查询被拒绝/);
  assert.deepEqual(queries, ["5座经济1000"]);
});

test("车辆只在正常空结果后查询座位兜底，保留实际命中关键字", async () => {
  const queries: string[] = [];
  const result = await matchVehicleResource(buildVehicleResourceQuery({ city: "成都" }), 1000,
    async query => {
      queries.push(query);
      return { data: { list: query === "5座1000" ? [{ resourceGroupId: 42, resourceGroupName: "5座1000" }] : [] } };
    });
  assert.deepEqual(queries, ["5座经济1000", "5座1000"]);
  assert.equal(result.matchedQuery, "5座1000");
  assert.equal(result.selected?.resourceGroupId, 42);
});

function poiRuntime(overrides: Partial<OrchestratorRuntime>): OrchestratorRuntime {
  return {
    loadCurrentProduct: async () => ({}), loadExistingResearchTasks: async () => [],
    loadHistory: async () => [], loadAcceptedModules: async () => [],
    writeModule: async () => ({ ok: true }), addResearchTask: async () => "task",
    ...overrides,
  };
}

test("营业状态查询失败或超时不返回可回填的 POI", async () => {
  for (const getPoiAvailability of [async () => { throw new Error("查询失败"); },
    async () => new Promise<never>(() => {})]) {
    const result = await queryPoi({ localProductId: "p", keyword: "景点", queryTimeoutMs: 5,
      runtime: poiRuntime({ suggestPoi: async () => ({ poiName: "景点", poiId: 1 }), getPoiAvailability }),
    });
    assert.equal(result.match, null);
    assert.equal(result.failed, true);
    assert.equal(result.suspended, false);
  }
});

test("不确定和暂停营业结果即使带编号也不能回填", async () => {
  for (const status of ["uncertain", "suspended"] as const) {
    const result = await queryPoi({ localProductId: "p", keyword: "景点", queryTimeoutMs: 5,
      runtime: poiRuntime({ resolvePoiSelection: async () => ({ status, match: { poiName: "景点", poiId: 1 } }) }),
    });
    assert.equal(result.match, null);
    assert.equal(result.suspended, status === "suspended");
  }
});

test("VBK 酒店匹配遵守锁定城市，不回退到异地第一条资源", () => {
  assert.equal(hotelResourceQuery({ product: { basicInfo: { meetingCity: "成都市", destinationCity: "厦门" } } }), "成都酒店");
  const resources = [
    { resourceId: 1, resourceName: "成都名字但厦门归属酒店", destinationCityName: "厦门", categoryName: "酒店" },
    { resourceId: -1, resourceName: "成都坏编号酒店", destinationCityName: "成都市", categoryName: "酒店" },
    { resourceId: 2, resourceName: "有效酒店", destinationCityName: "成都市", categoryName: "酒店" },
  ];
  assert.equal(firstHotelResource({ resources }, "成都")?.resourceId, 2);
  assert.equal(firstHotelResource({ resources: resources.slice(0, 1) }, "成都"), undefined);
});

test("酒店规则配置不查询平台酒店库", async () => {
  let queried = false;
  const page = { evaluate: async () => { queried = true; throw new Error("不应查询"); } };
  const result = await resolveHotelResource(page as never, { product: {} } as never);
  assert.deepEqual(result.resolved.rules, { autoMatch: true, grades: [3, 4, 5] });
  assert.equal(queried, false);
});
