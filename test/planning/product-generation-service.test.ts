import assert from "node:assert/strict";
import test from "node:test";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import { ProductMutationService } from "../../src/main/application/product-mutation-service.js";
import { createGenerationStageTools } from "../../src/main/agent/integration-generate.js";
import { ProductGenerationService } from "../../src/main/planning/product-generation.js";
import { detectAcceptedModulesFromProduct } from "../../src/main/planning/runtime-accepted-modules.js";
import type { OrchestratorRuntime } from "../../src/main/planning/types.js";
import type {
  PlanningModule,
  PlanningStageOutput,
  ResearchTaskProposal,
} from "../../src/shared/contracts-planning.js";
import type { ProductDetail } from "../../src/shared/contracts.js";

class MemoryRuntime implements OrchestratorRuntime {
  readonly writes: PlanningModule[] = [];
  constructor(readonly detail: ProductDetail) {}
  async loadExistingResearchTasks() { return []; }
  async writeModule(_id: string, module: PlanningModule, path: string, value: unknown) {
    this.writes.push(module);
    this.detail.product = setPath(this.detail.product as Record<string, unknown>, path, value) as ProductDetail["product"];
    return { ok: true };
  }
  async addResearchTask(_id: string, _task: ResearchTaskProposal) { return "task"; }
  async loadHistory() { return []; }
  async loadCurrentProduct() { return this.detail.product as Record<string, unknown>; }
  async loadAcceptedModules() {
    return detectAcceptedModulesFromProduct(this.detail.product as Record<string, unknown>);
  }
}

function product(): ProductDetail {
  const detail = buildProductSnapshot({ destination: "成都", days: 1, productForm: "privateTour" });
  Object.assign(detail.product.basicInfo!, {
    province: "四川",
    subtitle: "成都一日精华",
    operationNotes: "按已确认行程安排",
  });
  detail.product.itinerary = [{
    day: 1,
    title: "宽窄巷子",
    description: "游览宽窄巷子，了解成都街巷文化。",
    hotel: "无",
    meals: "自理",
    spots: [{ name: "宽窄巷子", kind: "attraction", poiName: "宽窄巷子", poiId: 101 }],
  }];
  return detail;
}

function itineraryOutput(): PlanningStageOutput {
  return {
    reply: "已生成行程",
    modules: [{
      module: "itinerary",
      status: "accepted",
      value: [{
        day: 1,
        title: "宽窄巷子",
        description: "游览宽窄巷子，了解成都街巷文化。",
        hotel: "无",
        meals: "自理",
        spots: [{ name: "宽窄巷子", kind: "attraction", poiName:  "虚构 POI", poiId: 999 }],
      }],
    }],
  };
}

function service(args: {
  detail?: ProductDetail;
  output?: PlanningStageOutput;
  generate?: () => Promise<PlanningStageOutput>;
  events?: string[];
  resolve?: (detail: ProductDetail) => Promise<void>;
}) {
  const detail = args.detail ?? product();
  const runtime = new MemoryRuntime(detail);
  const events = args.events ?? [];
  return {
    detail,
    runtime,
    generation: new ProductGenerationService({
      getProduct: () => detail,
      runtime,
      generateStage: async () => {
        events.push("generate");
        return args.generate ? args.generate() : structuredClone(args.output ?? itineraryOutput());
      },
      beforePresentation: () => { events.push("beforePresentation"); },
      clearUnverifiedItineraryPois: (value) => {
        events.push("clearPois");
        for (const day of value as Array<{ spots: Array<Record<string, unknown>> }>) {
          for (const spot of day.spots) { spot.poiId = null; spot.poiName = null; }
        }
      },
      resolveItineraryResources: async () => {
        events.push("resolveResources");
        await args.resolve?.(detail);
      },
      refreshSatisfiedResearchTasks: () => { events.push("refreshResearch"); },
    }),
  };
}

test("itinerary pipeline clears model POIs, persists, resolves resources, then revalidates", async () => {
  const events: string[] = [];
  const setup = service({ events });
  const result = await setup.generation.generate(setup.detail.id, "itinerary");

  assert.deepEqual(events, ["generate", "clearPois", "resolveResources", "refreshResearch"]);
  assert.deepEqual(result.applied.accepted.map((item) => item.module), ["itinerary"]);
  const spot = setup.detail.product.itinerary![0]!.spots![0]!;
  assert.equal(spot.poiId, null);
  assert.equal(spot.poiName, null);
});

test("invalid persisted itinerary blocks resource work before the callback", async () => {
  const events: string[] = [];
  const setup = service({ events });
  setup.runtime.writeModule = async () => {
    setup.detail.product.itinerary = [{ day: 1, title: "损坏行程", spots: [] }];
    return { ok: true };
  };

  await assert.rejects(
    setup.generation.generate(setup.detail.id, "itinerary"),
    /写入后回读结构无效/,
  );
  assert.deepEqual(events, ["generate", "clearPois"]);
});

test("resource callback corruption is caught by the second persisted readback", async () => {
  const events: string[] = [];
  const setup = service({
    events,
    resolve: async (detail) => {
      detail.product.itinerary = [{ day: 1, title: "损坏行程", spots: [] }];
    },
  });

  await assert.rejects(
    setup.generation.generate(setup.detail.id, "itinerary"),
    /写入后回读结构无效/,
  );
  assert.deepEqual(events, ["generate", "clearPois", "resolveResources", "refreshResearch"]);
});

test("presentation fallback repairs before generation and returns one accepted summary per module", async () => {
  const events: string[] = [];
  const setup = service({
    events,
    output: {
      reply: "presentation invalid",
      modules: [{ module: "presentation", status: "rejected", reason: "模型未返回图文" }],
    },
  });
  setup.detail.product.presentation = undefined;

  const result = await setup.generation.generate(setup.detail.id, "presentation");

  assert.deepEqual(events.slice(0, 2), ["beforePresentation", "generate"]);
  assert.equal(result.applied.accepted.filter((item) => item.module === "presentation").length, 1);
  assert.deepEqual(
    result.applied.accepted.find((item) => item.module === "presentation")?.acceptedFields,
    ["recommendation", "features", "recommendations", "cover"],
  );
  assert.equal(result.applied.rejected.some((item) => item.module === "presentation"), false);
  assert.equal((setup.detail.product.presentation?.recommendations ?? []).length, 3);
});

test("generator failures fall back only for presentation and commercial", async () => {
  for (const stage of ["presentation", "commercial"] as const) {
    const setup = service({ generate: async () => { throw new Error("provider failed"); } });
    if (stage === "presentation") setup.detail.product.presentation = undefined;
    await setup.generation.generate(setup.detail.id, stage);
  }
  const setup = service({ generate: async () => { throw new Error("provider failed"); } });
  await assert.rejects(setup.generation.generate(setup.detail.id, "basicInfo"), /provider failed/);
});

test("basicInfo write ACK without persisted fields is returned as rejected", async () => {
  const detail = product();
  Object.assign(detail.product.basicInfo!, { subtitle: "", province: "", operationNotes: "" });
  const setup = service({
    detail,
    output: {
      reply: "ok",
      modules: [{
        module: "basicInfo", status: "accepted",
        value: { subtitle: "成都一日精华", province: "四川", operationNotes: "按已确认行程安排" },
      }],
    },
  });
  setup.runtime.writeModule = async () => ({ ok: true });

  const result = await setup.generation.generate(detail.id, "basicInfo");
  assert.equal(result.applied.accepted.some((item) => item.module === "basicInfo"), false);
  assert.match(result.applied.rejected.find((item) => item.module === "basicInfo")?.reason ?? "", /写入后回读未确认/);
});

test("commercial readback keeps persisted modules and rejects ACK-only siblings", async () => {
  const detail = product();
  detail.product.commercial = {};
  const setup = service({
    detail,
    output: {
      reply: "ok",
      modules: [
        { module: "pricing", status: "accepted", value: { currency: "CNY", adult: 1880, child: 980 } },
        { module: "inventory", status: "accepted", value: { startDate: "2026-11-01", endDate: "2026-12-31", dailyQuota: 6 } },
      ],
    },
  });
  const persist = setup.runtime.writeModule.bind(setup.runtime);
  setup.runtime.writeModule = async (id, module, path, value) => module === "pricing"
    ? persist(id, module, path, value)
    : { ok: true };

  const result = await setup.generation.generate(detail.id, "commercial");
  assert.equal(result.applied.accepted.some((item) => item.module === "pricing"), true);
  assert.equal(result.applied.accepted.some((item) => item.module === "inventory"), false);
  assert.match(result.applied.rejected.find((item) => item.module === "inventory")?.reason ?? "", /写入后回读未确认/);
  assert.equal(result.deterministicAcceptedModules.includes("inventory"), false);
});

test("Agent tool factory reads the live browser only when a generation tool executes", async () => {
  let saved = product();
  saved.product.commercial = {};
  let browserReads = 0;
  const store = {
    getProduct: () => saved,
    updateProduct: (_id: string, next: Record<string, unknown>) => { saved = { ...saved, product: next }; },
    getSetting: () => undefined,
    addResearchTask: () => "task",
  };
  const deps = {
    db: store as never,
    get browser() { browserReads += 1; return { generation: browserReads } as never; },
    automation: {} as never,
    productWorkflows: { runVbkPageExclusive: async <T>(work: () => Promise<T>) => work() } as never,
    productMutations: new ProductMutationService(store),
    generateStage: async () => ({ reply: "ok", modules: [] }),
    disambiguatePoiOption: async () => ({ pickedText: null, confidence: 0 }),
    disambiguateStationOption: async () => ({ pickedText: null, reasoning: "" }),
    emitProduct: () => undefined,
  };
  const tools = createGenerationStageTools({
    deps, get: () => saved,
    resolveTrafficAvailability: async () => null,
    resolveItineraryPoisAndTraffic: async () => undefined,
    clearUnverifiedItineraryPois: () => undefined,
  });
  assert.equal(browserReads, 0);
  await tools.find((item) => item.name === "generate_product_module")!.execute(
    { stage: "commercial" },
    { localProductId: saved.id, accountKey: "account", productVersion: "v1" },
  );
  assert.equal(browserReads, 1);
});

function setPath(product: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const next = structuredClone(product);
  const segments = path.split("/").slice(1);
  let parent = next;
  for (const segment of segments.slice(0, -1)) {
    parent = (parent[segment] ??= {}) as Record<string, unknown>;
  }
  parent[segments.at(-1)!] = value;
  return next;
}
