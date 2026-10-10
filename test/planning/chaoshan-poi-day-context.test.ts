import test from "node:test";
import assert from "node:assert/strict";
import { isPlanningPoiCandidateInContext } from "../../src/main/planning/poi-auto-selection.js";
import { enrichItineraryPois } from "../../src/main/planning/poi-enrichment.js";
import type { OrchestratorRuntime } from "../../src/main/planning/types.js";

const product = {
  basicInfo: { destinationCity: "潮汕", meetingCity: "潮汕", province: "广东", userIdea: "D2 南澳大桥 > 北回归线；D3 炮台公园 > 小公园 > 汕头邮政总局" },
  itinerary: [
    { day: 2, title: "南澳岛环线", spots: [{ name: "北回归线" }] },
    { day: 3, title: "汕头老城", spots: [{ name: "炮台公园" }] },
  ],
};

test("同省唯一同名候选不能覆盖潮汕行程日已明确的城市", () => {
  for (const name of ["北回归线", "炮台公园"]) {
    const wrong = { index: 0, poiName: name, poiId: 1, province: "广东", city: "中山", selectable: true, textFields: [] };
    assert.equal(isPlanningPoiCandidateInContext(wrong, product.basicInfo, product, name, [wrong]), false);
    const local = { ...wrong, city: "汕头" };
    assert.equal(isPlanningPoiCandidateInContext(local, product.basicInfo, product, name, [local]), true);
  }
});

test("缺失 POI 按当天城市查询且不改变原路线或城市锚点", async () => {
  const contexts: unknown[] = [];
  let written: unknown;
  const before = structuredClone(product);
  const runtime = {
    loadCurrentProduct: async () => product,
    loadExistingResearchTasks: async () => [],
    loadHistory: async () => [],
    loadAcceptedModules: async () => ["itinerary"],
    suggestPoi: async (keyword: string, context: unknown) => {
      contexts.push(context);
      return { poiName: keyword === "北回归线" ? "北回归线广场" : "石炮台公园", poiId: keyword === "北回归线" ? 39215763 : 83078 };
    },
    addResearchTask: async () => "task",
    writeModule: async (_id: string, _module: unknown, _path: string, value: unknown) => { written = value; return { ok: true }; },
  } as OrchestratorRuntime;
  await enrichItineraryPois({ localProductId: "chaoshan", destination: "潮汕", runtime, persistedTaskKeys: new Set() });
  assert.deepEqual(contexts, [{ destinationCity: "汕头", province: "广东" }, { destinationCity: "汕头", province: "广东" }]);
  assert.deepEqual(product, before);
  assert.deepEqual((written as typeof product.itinerary).map(day => day.spots.map(spot => spot.name)), [["北回归线"], ["炮台公园"]]);
});
