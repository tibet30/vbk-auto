import test from "node:test";
import assert from "node:assert/strict";
import { enrichItineraryPois } from "../../src/main/planning/poi-enrichment.js";
import type { OrchestratorRuntime } from "../../src/main/planning/types.js";
import type { ResearchTaskProposal } from "../../src/shared/contracts-planning.js";

test("POI 补全查询携带产品目的城市和省份上下文", async () => {
  const contexts: unknown[] = [];
  const runtime = testRuntime({
    product: {
      basicInfo: { destinationCity: "乌鲁木齐", province: "新疆" },
      itinerary: [{ day: 1, spots: [{ name: "南山风景区", poiName: null, poiId: null }] }],
    },
    suggestPoi: async (_keyword, context) => {
      contexts.push(context);
      return { poiName: "乌鲁木齐市南山风景区", poiId: 99101 };
    },
  });

  await enrichItineraryPois({
    localProductId: "poi-context",
    destination: "新疆",
    runtime,
    persistedTaskKeys: new Set(),
  });

  assert.deepEqual(contexts, [{ destinationCity: "乌鲁木齐", province: "新疆" }]);
});

test("已完整 POI 未通过目的地省份复核时清空映射并生成核查任务", async () => {
  let written: any;
  const runtime = testRuntime({
    product: {
      basicInfo: { destinationCity: "乌鲁木齐", province: "新疆" },
      itinerary: [{ day: 3, spots: [{ name: "南山风景区", poiName: "南山风景区", poiId: 78174 }] }],
    },
    suggestPoi: async () => null,
    write: (value) => { written = value; },
  });

  const result = await enrichItineraryPois({
    localProductId: "poi-stale-context",
    destination: "新疆",
    runtime,
    persistedTaskKeys: new Set(),
    reviewCompletePois: true,
  });

  assert.deepEqual(written[0].spots[0], { name: "南山风景区", poiName: null, poiId: null });
  assert.equal(result[0].label, "核查 南山风景区 的 VBK POI 映射");
  assert.match(result[0].detail ?? "", /目的地\/省份复核/);
});

function testRuntime(args: {
  product: Record<string, unknown>;
  suggestPoi: (keyword: string, context?: { destinationCity?: string; province?: string }) => Promise<{ poiName: string; poiId: number } | null>;
  write?: (value: any) => void;
}) {
  const tasks: ResearchTaskProposal[] = [];
  return {
    tasks,
    suggestPoi: args.suggestPoi,
    loadExistingResearchTasks: async () => [],
    writeModule: async (_localProductId: string, _module: any, _path: string, value: any) => {
      args.write?.(value);
      return { ok: true };
    },
    addResearchTask: async (_localProductId: string, task: ResearchTaskProposal) => {
      tasks.push(task);
      return task.label;
    },
    loadHistory: async () => [],
    loadCurrentProduct: async () => args.product,
    loadAcceptedModules: async () => ["itinerary" as const],
  } satisfies OrchestratorRuntime & { tasks: ResearchTaskProposal[] };
}
