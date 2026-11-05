import test from "node:test";
import assert from "node:assert/strict";
import { enrichItineraryPois } from "../../src/main/planning/poi-enrichment.js";
import type { OrchestratorRuntime, VerifiedPoiMapping } from "../../src/main/planning/types.js";

test("受控地域 POI 解析把精确映射凭证交给持久化写入口", async () => {
  let receipt: readonly VerifiedPoiMapping[] | undefined;
  const product = {
    basicInfo: { destinationCity: "广安", province: "四川" },
    itinerary: [{ day: 1, spots: [{ name: "白塔公园", poiName: null, poiId: null }] }],
  };
  const runtime: OrchestratorRuntime = {
    resolvePoiSelection: async () => ({
      status: "available",
      match: { poiName: "白塔公园", poiId: 148594811, province: "四川", city: "广安", district: "广安" },
    }),
    loadExistingResearchTasks: async () => [],
    writeModule: async () => ({ ok: true }),
    writeResolvedItineraryPois: async (_id, _itinerary, _previous, mappings) => {
      receipt = mappings;
      return { ok: true };
    },
    addResearchTask: async () => "task",
    loadHistory: async () => [],
    loadCurrentProduct: async () => product,
    loadAcceptedModules: async () => ["itinerary"],
  };

  await enrichItineraryPois({
    localProductId: "guangan", destination: "广安", runtime, persistedTaskKeys: new Set(),
  });

  assert.deepEqual(receipt, [{
    day: 1, spotName: "白塔公园", poiName: "白塔公园", poiId: 148594811,
    province: "四川", city: "广安", district: "广安",
  }]);
});

test("不带地域与营业校验的 suggestPoi 结果不能生成任务结案凭证", async () => {
  let receipt: readonly VerifiedPoiMapping[] | undefined;
  const runtime: OrchestratorRuntime = {
    suggestPoi: async () => ({ poiName: "白塔公园", poiId: 148594811 }),
    loadExistingResearchTasks: async () => [],
    writeModule: async () => ({ ok: true }),
    writeResolvedItineraryPois: async (_id, _itinerary, _previous, mappings) => {
      receipt = mappings;
      return { ok: true };
    },
    addResearchTask: async () => "task",
    loadHistory: async () => [],
    loadCurrentProduct: async () => ({
      itinerary: [{ day: 1, spots: [{ name: "白塔公园", poiName: null, poiId: null }] }],
    }),
    loadAcceptedModules: async () => ["itinerary"],
  };

  await enrichItineraryPois({
    localProductId: "bare-suggest", destination: "广安", runtime, persistedTaskKeys: new Set(),
  });
  assert.deepEqual(receipt, []);
});

test("AI 裁决的绑定把裁决置信度与理由随映射交给写入口，用于生成裁决凭证", async () => {
  let receipt: readonly VerifiedPoiMapping[] | undefined;
  const product = {
    basicInfo: { destinationCity: "成都", province: "四川" },
    itinerary: [{ day: 1, spots: [{ name: "毕棚沟", poiName: null, poiId: null }] }],
  };
  const runtime: OrchestratorRuntime = {
    resolvePoiSelection: async () => ({
      status: "available",
      match: { poiName: "毕棚沟", poiId: 89964, province: "四川", city: "阿坝", district: "理县",
        adjudication: { confidence: 0.95, reasoning: "沿当天路线" } },
    }),
    loadExistingResearchTasks: async () => [],
    writeModule: async () => ({ ok: true }),
    writeResolvedItineraryPois: async (_id, _itinerary, _previous, mappings) => {
      receipt = mappings;
      return { ok: true };
    },
    addResearchTask: async () => "task",
    loadHistory: async () => [],
    loadCurrentProduct: async () => product,
    loadAcceptedModules: async () => ["itinerary"],
  };

  await enrichItineraryPois({
    localProductId: "aba", destination: "成都", runtime, persistedTaskKeys: new Set(),
  });

  assert.deepEqual(receipt, [{
    day: 1, spotName: "毕棚沟", poiName: "毕棚沟", poiId: 89964, province: "四川", city: "阿坝", district: "理县",
    adjudication: { confidence: 0.95, reasoning: "沿当天路线" },
  }]);
});
