import test from "node:test";
import assert from "node:assert/strict";
import { enrichItineraryPois } from "../../src/main/planning/poi-enrichment.js";
import type { OrchestratorRuntime } from "../../src/main/planning/types.js";
import type { ResearchTaskProposal } from "../../src/shared/contracts-planning.js";

test("suggestPoi 返回 poiId 为空时不算命中，会继续替换为有效 POI", async () => {
  const queries: string[] = [];
  let written: any;
  const runtime = testRuntime({
    product: { itinerary: [{ day: 1, spots: [{ name: "哈尔滨太平国际机场", poiName: null, poiId: null }] }] },
    suggestPoi: async (keyword) => {
      queries.push(keyword);
      if (keyword === "哈尔滨太平国际机场") return { poiName: "哈尔滨太平国际机场", poiId: null as unknown as number };
      if (keyword === "圣索菲亚教堂") return { poiName: "圣索菲亚教堂", poiId: 77064 };
      return null;
    },
    write: (value) => { written = value; },
  });
  await enrichItineraryPois({
    localProductId: "invalid-direct-poi",
    destination: "哈尔滨",
    runtime,
    persistedTaskKeys: new Set(),
    resolvePoiName: async () => "圣索菲亚教堂",
  });

  assert.deepEqual(queries, ["圣索菲亚教堂"]);
  assert.deepEqual(written[0].spots[0], { name: "圣索菲亚教堂", poiName: "圣索菲亚教堂", poiId: 77064 });
  assert.equal(runtime.tasks.length, 0);
});

test("交通或住宿节点即使 suggestPoi 返回 ID 也不作为有效景点", async () => {
  const queries: string[] = [];
  let written: any;
  const runtime = testRuntime({
    product: { itinerary: [{ day: 1, spots: [{ name: "酒店集合点", poiName: null, poiId: null }] }] },
    suggestPoi: async (keyword) => {
      queries.push(keyword);
      if (keyword === "酒店集合点") return { poiName: "酒店集合点", poiId: 9001 };
      if (keyword === "太阳岛风景区") return { poiName: "太阳岛风景区", poiId: 80630 };
      return null;
    },
    write: (value) => { written = value; },
  });
  await enrichItineraryPois({
    localProductId: "travel-node-poi",
    destination: "哈尔滨",
    runtime,
    persistedTaskKeys: new Set(),
    resolvePoiName: async () => "太阳岛风景区",
  });

  assert.deepEqual(queries, ["太阳岛风景区"]);
  assert.deepEqual(written[0].spots[0], { name: "太阳岛风景区", poiName: "太阳岛风景区", poiId: 80630 });
});

test("AI 替代候选是交通节点时会拒绝并继续下一候选", async () => {
  const queries: string[] = [];
  let written: any;
  const runtime = testRuntime({
    product: { itinerary: [{ day: 1, spots: [{ name: "接机点", poiName: null, poiId: null }] }] },
    suggestPoi: async (keyword) => {
      queries.push(keyword);
      return keyword === "圣索菲亚教堂" ? { poiName: "圣索菲亚教堂", poiId: 77064 } : null;
    },
    write: (value) => { written = value; },
  });
  await enrichItineraryPois({
    localProductId: "fallback-travel-node",
    destination: "哈尔滨",
    runtime,
    persistedTaskKeys: new Set(),
    resolvePoiName: async ({ attempt }) => attempt === 1 ? "哈尔滨太平国际机场" : "圣索菲亚教堂",
  });

  assert.deepEqual(queries, ["圣索菲亚教堂"]);
  assert.deepEqual(written[0].spots[0], { name: "圣索菲亚教堂", poiName: "圣索菲亚教堂", poiId: 77064 });
});

function testRuntime(args: {
  product: Record<string, unknown>;
  suggestPoi: (keyword: string) => Promise<{ poiName: string; poiId: number } | null>;
  write?: (value: any) => void;
}) {
  const tasks: ResearchTaskProposal[] = [];
  return {
    tasks,
    suggestPoi: args.suggestPoi,
    loadExistingResearchTasks: async () => [],
    writeModule: async (_localProductId: string, _module: any, _path: string, value: any) => { args.write?.(value); return { ok: true }; },
    addResearchTask: async (_localProductId: string, task: ResearchTaskProposal) => { tasks.push(task); return task.label; },
    loadHistory: async () => [],
    loadCurrentProduct: async () => args.product,
    loadAcceptedModules: async () => ["itinerary" as const],
  } satisfies OrchestratorRuntime & { tasks: ResearchTaskProposal[] };
}
