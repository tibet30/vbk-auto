import test from "node:test";
import assert from "node:assert/strict";
import { runPlan } from "../../src/main/planning/plan-orchestrator.js";
import { AI_WRITABLE_PATHS } from "../../src/main/planning/schemas.js";
import type { GenerationStateStore, OrchestratorRuntime } from "../../src/main/planning/types.js";
import type { Planner, PlannerRequest, PlanningGenerationState, PlanningModule } from "../../src/shared/contracts-planning.js";

const skeleton = {
  destination: "太原", days: 1, nights: 0, productForm: "privateTour" as const,
  productType: "domesticShort" as const, supplierProductCode: "NEW",
};

test("resume 在 presentation 前只补 itinerary 缺失 POI，不重跑 itinerary AI", async () => {
  const events: string[] = [];
  let product: Record<string, unknown> = {
    itinerary: [{ day: 1, title: "D1", spots: [{ name: "晋祠", poiName: null, poiId: null }], description: "游览", hotel: "", meals: "午餐自理" }],
  };
  const state: PlanningGenerationState = {
    projectId: "resume-poi", currentStage: "presentation",
    completedStages: ["skeleton", "basicInfo", "itinerary"], stages: [],
    status: "needs_user", resumeAt: new Date().toISOString(),
  };
  const store: GenerationStateStore = {
    load: async () => state,
    save: async (next) => { Object.assign(state, structuredClone(next)); },
  };
  const runtime: OrchestratorRuntime = {
    suggestPoi: async (keyword) => {
      events.push(`poi:${keyword}`);
      return { poiName: "晋祠博物馆", poiId: "83199" };
    },
    loadExistingResearchTasks: async () => [],
    writeModule: async (_projectId, _module: PlanningModule, path, value) => {
      events.push(`write:${path}`);
      if (path === AI_WRITABLE_PATHS.itinerary) product = { ...product, itinerary: value };
      return { ok: true };
    },
    addResearchTask: async () => "task",
    loadHistory: async () => [],
    loadCurrentProduct: async () => product,
    loadAcceptedModules: async () => ["skeleton", "basicInfo", "itinerary"],
  };
  const planner: Planner = {
    async generateStage(request: PlannerRequest) {
      events.push(`planner:${request.stage}`);
      if (request.stage === "presentation") {
        return {
          reply: "presentation",
          modules: [{ module: "presentation", status: "accepted", value: {
            recommendationCategory: "优选行程", recommendation: "推荐",
            recommendations: [
              { category: "优选行程", text: "行程" },
              { category: "精选酒店", text: "酒店" },
              { category: "缤纷景点", text: "景点" },
            ], features: "特色",
          } }],
        };
      }
      throw new Error(`stop at ${request.stage}`);
    },
  };

  await runPlan({ projectId: "resume-poi", skeleton, store, runtime, planner, options: { stageRetryLimit: 1 } });

  assert.deepEqual(events.slice(0, 3), [
    "poi:晋祠",
    `write:${AI_WRITABLE_PATHS.itinerary}`,
    "planner:presentation",
  ]);
  assert.ok(!events.includes("planner:itinerary"));
  const spot = ((product.itinerary as Array<{ spots: Array<{ poiName: string; poiId: string }> }>)[0].spots[0]);
  assert.deepEqual(spot, { name: "晋祠", poiName: "晋祠博物馆", poiId: "83199" });
});
