import test from "node:test";
import assert from "node:assert/strict";
import { enrichItineraryPois } from "../../src/main/planning/poi-enrichment.js";
import type { OrchestratorRuntime } from "../../src/main/planning/types.js";
import type { ResearchTaskProposal } from "../../src/shared/contracts-planning.js";

test("交通节点不会被替换为其他景点，保留原位置并要求人工处理", async () => {
  const queries: string[] = [];
  const runtime = testRuntime({
    product: { itinerary: [{ day: 1, spots: [{ name: "哈尔滨太平国际机场", poiName: null, poiId: null }] }] },
    suggestPoi: async (keyword) => {
      queries.push(keyword);
      if (keyword === "哈尔滨太平国际机场") return { poiName: "哈尔滨太平国际机场", poiId: null as unknown as number };
      return null;
    },
  });
  await enrichItineraryPois({
    localProductId: "invalid-direct-poi",
    destination: "哈尔滨",
    runtime,
    persistedTaskKeys: new Set(),
  });

  assert.deepEqual(queries, []);
  assert.equal(runtime.tasks.length, 1);
  assert.match(runtime.tasks[0].detail ?? "", /接送\/交通\/住宿节点/);
});

test("普通景点查询返回无效 POI 时不搜索替代景点", async () => {
  const queries: string[] = [];
  const runtime = testRuntime({
    product: { itinerary: [{ day: 1, spots: [{ name: "无效景点", poiName: null, poiId: null }] }] },
    suggestPoi: async (keyword) => {
      queries.push(keyword);
      return { poiName: "酒店集合点", poiId: 9001 };
    },
  });
  await enrichItineraryPois({
    localProductId: "travel-node-poi",
    destination: "哈尔滨",
    runtime,
    persistedTaskKeys: new Set(),
  });

  assert.deepEqual(queries, ["无效景点"]);
  assert.equal(runtime.tasks.length, 1);
  assert.match(runtime.tasks[0].detail ?? "", /保留原景点和原行程位置/);
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
