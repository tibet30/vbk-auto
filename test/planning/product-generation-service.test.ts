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
  async resolveRecommendationCategoryPolicy() { return fixedRecommendationPolicy(); }
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

function fixedRecommendationPolicy() {
  return { source: "fixed-replay" as const, inputLocale: "zh-CN", productPatternId: 4, limited: true,
    categoryIds: [1, 2, 3, 5, 15], categories: ["服务保障", "贴心赠送", "精选酒店", "特色美食", "缤纷体验"], fetchedAt: "2026-10-16T00:00:00.000Z" };
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
  titles?: (requests: Array<{ day: number }>) => Promise<Array<{ day: number; title: string }>>;
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
      ...(args.titles ? { generateItineraryDayTitles: async (_id: string, requests: Array<{ day: number }>) => {
        events.push("titles");
        return args.titles!(requests);
      } } : {}),
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

test("presentation model rejection fails visibly without local fallback copy", async () => {
  const events: string[] = [];
  const setup = service({
    events,
    output: {
      reply: "presentation invalid",
      modules: [{ module: "presentation", status: "rejected", reason: "模型未返回图文" }],
    },
  });
  setup.detail.product.presentation = undefined;

  await assert.rejects(setup.generation.generate(setup.detail.id, "presentation"),
    /推荐理由未处理：图文生成没有写入 presentation 模块（模型未返回图文；图文内容未通过校验.*不使用本地兜底文案）/);
  assert.deepEqual(events.slice(0, 2), ["beforePresentation", "generate"]);
  assert.equal(setup.detail.product.presentation?.recommendations, undefined, "不得写入本地兜底推荐理由");
});

test("generator failures fall back only for commercial; presentation errors propagate", async () => {
  const commercial = service({ generate: async () => { throw new Error("provider failed"); } });
  await commercial.generation.generate(commercial.detail.id, "commercial");
  for (const stage of ["presentation", "basicInfo"] as const) {
    const setup = service({ generate: async () => { throw new Error("provider failed"); } });
    if (stage === "presentation") setup.detail.product.presentation = undefined;
    await assert.rejects(setup.generation.generate(setup.detail.id, stage), /provider failed/);
  }
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

test("规划模型的合格天标题不调用 AI 重写", async () => {
  const events: string[] = [];
  const setup = service({ events, titles: async () => [] });
  await setup.generation.generate(setup.detail.id, "itinerary");
  assert.ok(!events.includes("titles"));
  assert.equal(setup.detail.product.itinerary![0]!.title, "宽窄巷子");
});

test("规划模型的超长天标题交给 AI 重写，AI 不合格时用兜底标题而不是截断", async () => {
  const long = "宽窄巷子" + "，漫步老成都街巷感受市井烟火".repeat(6);
  const output = itineraryOutput();
  (output.modules[0]!.value as Array<Record<string, unknown>>)[0]!.title = long;
  const rewritten = service({ output: structuredClone(output), titles: async () => [{ day: 1, title: "宽窄巷子漫步" }] });
  await rewritten.generation.generate(rewritten.detail.id, "itinerary");
  assert.equal(rewritten.detail.product.itinerary![0]!.title, "宽窄巷子漫步");

  const fallback = service({ output: structuredClone(output), titles: async () => { throw new Error("offline"); } });
  await fallback.generation.generate(fallback.detail.id, "itinerary");
  const title = fallback.detail.product.itinerary![0]!.title!;
  assert.ok([...title].length <= 70, title);
  assert.ok(title.includes("宽窄巷子"), title);
});
