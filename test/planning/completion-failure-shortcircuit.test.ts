import assert from "node:assert/strict";
import test from "node:test";
import { createPlanningPlanV2, runThreeStagePlan } from "../../src/main/planning/three-stage-orchestrator.js";
import { detectAcceptedModulesFromProduct } from "../../src/main/planning/runtime.js";
import type { OrchestratorRuntime } from "../../src/main/planning/types.js";
import type {
  Planner,
  PlannerRequest,
  PlanningModule,
  PlanningPlanV2,
  PlanningStageOutput,
  ThreeStagePlanningAi,
} from "../../src/shared/contracts-planning.js";

class Runtime implements OrchestratorRuntime {
  product: Record<string, unknown> = {
    basicInfo: { province: "山西", meetingCity: "太原", destinationCity: "太原" },
    commercial: {},
  };
  constructor(private readonly failCommercialWrite = false) {}

  async loadExistingResearchTasks() { return []; }
  async loadHistory() { return []; }
  async addResearchTask() { return "task"; }
  async loadCurrentProduct() { return this.product; }
  async loadAcceptedModules() { return detectAcceptedModulesFromProduct(this.product); }
  async writeModule(_id: string, _module: PlanningModule, path: string, value: unknown) {
    if (this.failCommercialWrite && path.startsWith("/commercial")) return { ok: false, reason: "商业字段写入失败" };
    const keys = path.split("/").slice(1);
    const next = structuredClone(this.product);
    let parent = next as Record<string, unknown>;
    for (let i = 0; i < keys.length - 1; i += 1) {
      parent[keys[i]!] = parent[keys[i]!] && typeof parent[keys[i]!] === "object" ? parent[keys[i]!] : {};
      parent = parent[keys[i]!] as Record<string, unknown>;
    }
    parent[keys.at(-1)!] = value;
    this.product = next;
    return { ok: true };
  }
}

class PlannerStub implements Planner {
  calls: string[] = [];
  constructor(private readonly failStage: string) {}

  async generateStage(request: PlannerRequest): Promise<PlanningStageOutput> {
    this.calls.push(request.stage);
    if (request.stage === this.failStage) return { reply: "缺失", modules: [] };
    if (request.stage === "basicInfo") {
      return { reply: "基础信息", modules: [{ module: "basicInfo", status: "accepted", value: {
        subtitle: "太原精华之旅", province: "山西", destinationCity: "太原", operationNotes: "按约定行程安排",
      } }] };
    }
    if (request.stage === "presentation") {
      return { reply: "展示文案", modules: [{ module: "presentation", status: "accepted", value: {
        recommendationCategory: "优选行程",
        recommendation: "舒适串联太原核心景点", recommendations: [
          { category: "优选行程", text: "节奏舒适" }, { category: "精选酒店", text: "精选住宿" }, { category: "缤纷景点", text: "覆盖核心景点" },
        ], features: "精选体验",
      } }] };
    }
    return { reply: "商业信息", modules: [
      { module: "pricing", status: "accepted", value: { currency: "CNY", adult: 1200, child: 600, minimumTravelers: 1 } },
      { module: "inventory", status: "accepted", value: { startDate: "2026-08-22", endDate: "2026-12-31", dailyQuota: 8 } },
      { module: "release", status: "accepted", value: { submitReview: false, publishAfterApproval: false, publicPriceCeiling: 3000, publicAuditRetries: 3 } },
    ] };
  }
}

function initialPlan(failStage: string): PlanningPlanV2 {
  const plan = createPlanningPlanV2("2026-08-22T00:00:00.000Z");
  const completed = new Set(["skeleton", "spotCandidates", "poiResolution", "itineraryDraft", "hotelResolution"]);
  if (failStage !== "basicInfo") completed.add("copy");
  if (failStage === "commercial") completed.add("presentation");
  return {
    ...plan,
    userIntent: { rawIdea: "", preferences: [], activities: [] },
    nodes: plan.nodes.map((entry) => ({
      ...entry,
      status: entry.id === "vehicleResource" ? "skipped" : completed.has(entry.id) ? "completed" : "pending",
      attempts: completed.has(entry.id) ? 1 : 0,
    })),
  };
}

async function runFailureCase(failStage: "basicInfo" | "presentation" | "commercial") {
  const runtime = new Runtime(failStage === "commercial");
  const planner = new PlannerStub(failStage);
  let coverCalls = 0;
  let vehicleCalls = 0;
  const persisted: PlanningPlanV2[] = [];
  const result = await runThreeStagePlan({
    localProductId: `completion-failure-${failStage}`,
    skeleton: { destination: "太原", province: "山西", city: "太原", days: 2, nights: 1, productForm: "privateTour", productType: "domesticShort", supplierProductCode: "TEST" },
    planner, ai: {} as ThreeStagePlanningAi, runtime, initialPlan: initialPlan(failStage),
    persist: async (plan) => { persisted.push(structuredClone(plan)); },
    assertVbkLogin: async () => undefined, queryPoi: async () => ({ best: null, candidates: [] }),
    resolveHotels: async () => ({ itinerary: [], dailyCandidates: [], searchDates: { checkin: "2026-08-22", checkout: "2026-08-23" } }),
    resolveCover: async () => { coverCalls += 1; return { complete: true, summary: "cover" }; },
    resolveVehicle: async () => { vehicleCalls += 1; return { complete: true, summary: "vehicle" }; },
    privateTour: true,
  });
  return { result, planner, coverCalls, vehicleCalls, persisted };
}

for (const [stage, expectedCalls] of [
  ["basicInfo", ["basicInfo", "basicInfo", "basicInfo"]],
  ["presentation", ["presentation", "presentation", "presentation"]],
  ["commercial", []],
] as const) {
  test(`${stage} completion 失败后立即短路后续节点`, async () => {
    const { result, planner, coverCalls, vehicleCalls, persisted } = await runFailureCase(stage);
    assert.equal(result.status, "needs_user");
    assert.equal(result.currentNode, stage === "basicInfo" ? "copy" : stage);
    assert.equal(result.nodes.find((node) => node.id === result.currentNode)?.status, "failed");
    assert.deepEqual(planner.calls, expectedCalls);
    assert.equal(coverCalls, 0);
    assert.equal(vehicleCalls, 0);
    const lastPersisted = persisted.at(-1)!;
    assert.equal(lastPersisted.status, result.status);
    assert.equal(lastPersisted.currentNode, result.currentNode);
    assert.deepEqual(lastPersisted.nodes.find((node) => node.id === result.currentNode), result.nodes.find((node) => node.id === result.currentNode));
  });
}

test("失败节点被用户重置后可继续完成剩余 completion 流程", async () => {
  const failed = await runFailureCase("basicInfo");
  const failedCopy = failed.result.nodes.find((node) => node.id === "copy")!;
  assert.equal(failedCopy.status, "failed");
  assert.equal(failedCopy.attempts, 3);

  const runtime = new Runtime();
  const planner = new PlannerStub("never");
  const recoveryPlan = initialPlan("basicInfo");
  const persisted: PlanningPlanV2[] = [];
  const result = await runThreeStagePlan({
    localProductId: "completion-failure-recovery",
    skeleton: { destination: "太原", province: "山西", city: "太原", days: 2, nights: 1, productForm: "privateTour", productType: "domesticShort", supplierProductCode: "TEST" },
    planner, ai: {} as ThreeStagePlanningAi, runtime, initialPlan: recoveryPlan,
    persist: async (plan) => { persisted.push(structuredClone(plan)); },
    assertVbkLogin: async () => undefined, queryPoi: async () => ({ best: null, candidates: [] }),
    resolveHotels: async () => ({ itinerary: [], dailyCandidates: [], searchDates: { checkin: "2026-08-22", checkout: "2026-08-23" } }),
    resolveCover: async () => ({ complete: true, summary: "cover" }),
    resolveVehicle: async () => ({ complete: true, summary: "vehicle" }),
    privateTour: true,
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(planner.calls, ["basicInfo", "presentation", "commercial"]);
  assert.equal(result.currentNode, "finalValidation");
  assert.equal(persisted.at(-1)?.status, result.status);
  assert.equal(persisted.at(-1)?.currentNode, result.currentNode);
});
