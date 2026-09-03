import assert from "node:assert/strict";
import test from "node:test";
import { AI_WRITABLE_PATHS } from "../../src/main/planning/schemas.js";
import { createPlanningPlanV2, runThreeStagePlan } from "../../src/main/planning/three-stage-orchestrator.js";
import { detectAcceptedModulesFromProduct } from "../../src/main/planning/runtime.js";
import type { OrchestratorRuntime } from "../../src/main/planning/types.js";
import type {
  Planner,
  PlannerRequest,
  PlanningGenerationState,
  PlanningModule,
  PlanningPlanV2,
  PlanningStageOutput,
  ThreeStagePlanningAi,
} from "../../src/shared/contracts-planning.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class CompletionRuntime implements OrchestratorRuntime {
  product: Record<string, unknown> = {
    basicInfo: { province: "山西", meetingCity: "太原", destinationCity: "太原" },
    commercial: {},
  };

  async loadExistingResearchTasks() { return []; }

  async writeModule(_localProductId: string, _module: PlanningModule, writePath: string, value: unknown) {
    const segments = writePath.split("/").slice(1);
    const next = structuredClone(this.product);
    let parent = next as Record<string, unknown>;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const key = segments[i];
      parent[key] = parent[key] && typeof parent[key] === "object" ? parent[key] : {};
      parent = parent[key] as Record<string, unknown>;
    }
    parent[segments.at(-1)!] = value;
    this.product = next;
    return { ok: true };
  }

  async writeResolvedHotelResources(_localProductId: string, operations: Record<string, unknown>) {
    this.product = { ...this.product, operations };
    return { ok: true };
  }

  async addResearchTask() { return "task"; }
  async loadHistory() { return []; }
  async loadCurrentProduct() { return this.product; }
  async loadAcceptedModules() { return detectAcceptedModulesFromProduct(this.product); }
}

class OrderedCompletionPlanner implements Planner {
  commercialStartedBeforePresentationPersist = false;
  presentationPersisted = false;
  calls: string[] = [];

  async generateStage(request: PlannerRequest): Promise<PlanningStageOutput> {
    this.calls.push(request.stage);
    if (request.stage === "presentation") {
      // The old Promise.all orchestration starts commercial while this request is
      // still in flight, before presentation can be written and persisted.
      await sleep(25);
      return {
        reply: "presentation",
        modules: [{ module: "presentation", status: "accepted", value: {
          recommendationCategory: "优选行程",
          recommendation: "核心景点舒适串联",
          recommendations: [
            { category: "优选行程", text: "节奏舒适" },
            { category: "精选酒店", text: "精选住宿" },
            { category: "缤纷景点", text: "覆盖核心景点" },
          ],
          features: "精选体验",
        } }],
      };
    }
    if (request.stage === "commercial") {
      if (!this.presentationPersisted) this.commercialStartedBeforePresentationPersist = true;
      return {
        reply: "commercial",
        modules: [
          { module: "pricing", status: "accepted", value: { currency: "CNY", adult: 1200, child: 600, minimumTravelers: 2 } },
          { module: "inventory", status: "accepted", value: { startDate: "2026-08-22", endDate: "2026-12-31", dailyQuota: 8 } },
          { module: "release", status: "accepted", value: { submitReview: false, publishAfterApproval: false, publicPriceCeiling: 3000, publicAuditRetries: 3 } },
        ],
      };
    }
    throw new Error(`unexpected stage ${request.stage}`);
  }
}

function completionPlan(): PlanningPlanV2 {
  const plan = createPlanningPlanV2("2026-08-22T00:00:00.000Z");
  const completed = new Set(["skeleton", "spotCandidates", "poiResolution", "itineraryDraft", "copy", "cover"]);
  return {
    ...plan,
    currentNode: "presentation",
    nodes: plan.nodes.map((node) => ({
      ...node,
      status: node.id === "vehicleResource" ? "skipped" as const : completed.has(node.id) ? "completed" as const : "pending" as const,
      attempts: completed.has(node.id) ? 1 : 0,
    })),
  };
}

test("completion nodes run in order and preserve presentation plus commercial fields", async () => {
  const runtime = new CompletionRuntime();
  const planner = new OrderedCompletionPlanner();
  const persisted: PlanningPlanV2[] = [];
  const initialPlan = completionPlan();
  const result = await runThreeStagePlan({
    localProductId: "completion-order",
    skeleton: { destination: "太原", province: "山西", city: "太原", days: 2, nights: 1, productForm: "privateTour", productType: "domesticShort", supplierProductCode: "ORDER" },
    planner,
    ai: {} as ThreeStagePlanningAi,
    runtime,
    initialPlan,
    persist: async (plan) => {
      await sleep(1);
      if (plan.nodes.find((node) => node.id === "presentation")?.status === "completed") planner.presentationPersisted = true;
      persisted.push(structuredClone(plan));
    },
    assertVbkLogin: async () => undefined,
    queryPoi: async () => ({ best: null, candidates: [] }),
    resolveCover: async () => ({ complete: true, summary: "cover already complete" }),
    resolveVehicle: async () => ({ complete: true, summary: "not used" }),
    privateTour: false,
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(planner.calls, ["presentation", "commercial"]);
  assert.equal(planner.commercialStartedBeforePresentationPersist, false);
  assert.ok(persisted.some((plan) => plan.nodes.find((node) => node.id === "presentation")?.status === "completed"));

  const presentation = runtime.product.presentation as Record<string, unknown>;
  const commercial = runtime.product.commercial as Record<string, unknown>;
  assert.equal(presentation.recommendation, "核心景点舒适串联");
  assert.equal(commercial.packageName, "太原2天1晚私家团");
  assert.deepEqual(commercial.pricing, { currency: "CNY", adult: 1200, child: 600, minimumTravelers: 1 });
  assert.deepEqual(commercial.inventory, { startDate: "2026-08-22", endDate: "2026-12-31", dailyQuota: 8 });
  assert.deepEqual(commercial.release, { submitReview: false, publishAfterApproval: false, publicPriceCeiling: 3000, publicAuditRetries: 3 });
  assert.ok(runtime.product.presentation);
  assert.ok(runtime.product.commercial);
  assert.equal(AI_WRITABLE_PATHS.presentation, "/presentation");
});

test("酒店节点把五个候选写入每日行程与资源配置", async () => {
  const runtime = new CompletionRuntime();
  runtime.product = {
    basicInfo: { province: "山西", meetingCity: "太原", destinationCity: "太原" },
    operations: { hotelTier: "当地5钻酒店/-38" },
    itinerary: [
      {
        day: 1, title: "晋祠", hotel: "当地住宿（待匹配）", description: "入住当地住宿（待匹配）",
        spots: [{ poiId: 79413, poiName: "晋祠", city: "太原" }],
      },
      { day: 2, title: "返程", hotel: "", description: "返程", spots: [{ poiId: 1, poiName: "太原古县城", city: "太原" }] },
    ],
  };
  const candidates = [
    { hotelId: 101, hotelName: "近处5钻", diamond: 5, score: 4.7, distanceKm: 2, cityName: "太原", anchorName: "晋祠", anchorCityId: 105 },
    { hotelId: 102, hotelName: "稍远5钻", diamond: 5, score: 4.9, distanceKm: 5, cityName: "太原", anchorName: "晋祠", anchorCityId: 105 },
    { hotelId: 103, hotelName: "最近4钻", diamond: 4, score: 4.9, distanceKm: 1, cityName: "太原", anchorName: "晋祠", anchorCityId: 105 },
    { hotelId: 104, hotelName: "再远5钻", diamond: 5, score: 4.6, distanceKm: 8, cityName: "太原", anchorName: "晋祠", anchorCityId: 105 },
    { hotelId: 105, hotelName: "远处5钻", diamond: 5, score: 4.5, distanceKm: 10, cityName: "太原", anchorName: "晋祠", anchorCityId: 105 },
  ];
  const plan = createPlanningPlanV2();
  const initialPlan: PlanningPlanV2 = {
    ...plan,
    userIntent: { rawIdea: "", preferences: [], activities: [] },
    nodes: plan.nodes.map((entry) => ({
      ...entry,
      status: entry.id === "hotelResolution" || entry.id === "finalValidation" ? "pending" : entry.id === "vehicleResource" ? "skipped" : "completed",
    })),
  };
  const result = await runThreeStagePlan({
    localProductId: "hotel-e2e", skeleton: { destination: "太原", province: "山西", city: "太原", days: 2, nights: 1, productForm: "groupTour", productType: "domesticShort", supplierProductCode: "HOTEL" },
    planner: {} as Planner, ai: {} as ThreeStagePlanningAi, runtime, initialPlan, persist: async () => undefined,
    assertVbkLogin: async () => undefined, queryPoi: async () => ({ best: null, candidates: [] }),
    resolveHotels: async (itinerary) => ({
      itinerary: itinerary.map((day) => day.day === 1 ? { ...day, hotel: candidates[0]!.hotelName, hotelCandidates: candidates } : day),
      dailyCandidates: [{ day: 1, candidates }], searchDates: { checkin: "2026-12-01", checkout: "2026-12-02" },
    }),
    resolveCover: async () => ({ complete: true, summary: "not used" }), resolveVehicle: async () => ({ complete: true, summary: "not used" }), privateTour: false,
  });
  assert.equal(result.status, "completed");
  const itinerary = runtime.product.itinerary as Array<Record<string, unknown>>;
  assert.equal(itinerary[0]?.hotel, "近处5钻");
  assert.deepEqual(itinerary[0]?.hotelCandidates, candidates);
  const resource = (runtime.product.operations as Record<string, unknown>).hotelResource as Record<string, unknown>;
  assert.equal(resource.resourceId, 101);
  assert.deepEqual(resource.dailyCandidates, [{ day: 1, candidates }]);
});
