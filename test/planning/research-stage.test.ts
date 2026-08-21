/**
 * research 阶段 deterministic 行为测试：
 *  - 不调用 AI（planner 不会收到 research 请求）；
 *  - 按 itinerary + 资源 / 封面缺口生成 POI / 用车 / 酒店 / 图片核查；
 *  - 同一份输入多次运行产生完全相同的任务清单；
 *  - 标签禁止「已确认 / 已解决」措辞；
 *  - AI 即使产出声称解决，runtime 也不会被 fake task 标记为 confirmed。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { runPlan } from "../../src/main/planning/plan-orchestrator.js";
import { pendingResearchTasks, planResearchTasks } from "../../src/main/planning/research-tasks.js";
import { detectAcceptedModulesFromProduct } from "../../src/main/planning/runtime.js";
import type {
  GenerationStateStore, OrchestratorRuntime,
} from "../../src/main/planning/types.js";
import type {
  Planner, PlannerRequest, PlanningStage, PlanningStageOutput, PlanningGenerationState, PlanningModule, ResearchTaskProposal,
} from "../../src/shared/contracts-planning.js";
import { AI_WRITABLE_PATHS } from "../../src/main/planning/schemas.js";

class ItineraryOnlyPlanner implements Planner {
  calls: PlanningStage[] = [];
  constructor(private readonly opts: { failPresentation?: boolean } = {}) {}
  async generateStage(request: PlannerRequest): Promise<PlanningStageOutput> {
    this.calls.push(request.stage);
    if (request.stage === "basicInfo") return { reply: "basic", modules: [{ module: "basicInfo", status: "accepted", value: { subtitle: "太原精华之旅", province: "山西", operationNotes: "待核查" } }] };
    if (request.stage === "itinerary") {
      return {
        reply: "itin",
        modules: [{ module: "itinerary", status: "accepted", value: [
          { day: 1, title: "D1", spots: [{name:"晋祠博物馆",poiName:null,poiId:null},{name:"太原古县城",poiName:null,poiId:null}], description: "D", hotel: "H", meals: "B/L/D" },
          { day: 2, title: "D2", spots: [{name:"山西博物院",poiName:null,poiId:null},{name:"晋商博物院",poiName:null,poiId:null}], description: "D", hotel: "", meals: "B/L/D" },
        ] }],
      };
    }
    if (request.stage === "presentation") {
      if (this.opts.failPresentation) return { reply: "pres missing", modules: [] };
      return {
        reply: "pres",
        modules: [{ module: "presentation", status: "accepted", value: {
          recommendationCategory: "优选行程",
          recommendation: "R",
          recommendations: [
            { category: "优选行程", text: "a" }, { category: "精选酒店", text: "b" }, { category: "缤纷景点", text: "c" },
          ],
          features: "f",
        } }],
      };
    }
    if (request.stage === "commercial") return { reply: "com", modules: [
      { module: "pricing", status: "accepted", value: { currency: "CNY", adult: 1000, child: 500, minimumTravelers: 2 } },
      { module: "inventory", status: "accepted", value: { startDate: "2026-08-10", endDate: "2026-12-31", dailyQuota: 6 } },
      { module: "terms", status: "accepted", value: { inclusions: "i", exclusions: "e", bookingNotes: "b", refundPolicy: "r" } },
      { module: "release", status: "accepted", value: { publicPriceCeiling: 2000, publicAuditRetries: 3 } },
    ] };
    throw new Error("unexpected " + request.stage);
  }
}

class InMemoryStore implements GenerationStateStore {
  state?: PlanningGenerationState;
  load() { return Promise.resolve(this.state); }
  save(s: PlanningGenerationState) { this.state = s; return Promise.resolve(); }
}

class FakeRuntime implements OrchestratorRuntime {
  product: Record<string, unknown> = { basicInfo: { province: "山西", subtitle: "太原精华之旅", operationNotes: "待核查", days: 2, nights: 1, meetingCity: "太原" } };
  researchTasks: ResearchTaskProposal[] = [];
  private keys = new Set<string>();
  async loadExistingResearchTasks() {
    return this.researchTasks.map((t) => ({ label: t.label, type: t.type }));
  }
  async writeModule(_id: string, _m: PlanningModule, path: string, value: unknown) {
    if (path === AI_WRITABLE_PATHS.skeleton) {
      this.product = { ...this.product, operations: { ...(this.product.operations as object | undefined ?? {}), ...(value as object) } };
      return { ok: true };
    }
    const segs = path.split("/").slice(1);
    const next = structuredClone(this.product) as Record<string, unknown>;
    let parent = next;
    for (let i=0;i<segs.length-1;i++) parent = (parent[segs[i]] ??= {}) as Record<string, unknown>;
    parent[segs.at(-1)!] = value;
    this.product = next;
    return { ok: true };
  }
  async addResearchTask(_id: string, task: ResearchTaskProposal) {
    const k = `${task.type}::${task.label}`;
    if (!this.keys.has(k)) {
      this.keys.add(k);
      this.researchTasks.push(task);
    }
    return k;
  }
  async suggestPoi(keyword: string) { return { poiName: `${keyword}（VBK）`, poiId: 1000 }; }
  async loadHistory() { return []; }
  async loadCurrentProduct() { return this.product; }
  async loadAcceptedModules(): Promise<PlanningModule[]> {
    return detectAcceptedModulesFromProduct(this.product);
  }
}

const skeleton = { destination: "太原", days: 2, nights: 1, productForm: "privateTour" as const, productType: "domesticShort" as const, supplierProductCode: "NEW" };

test("research 阶段由本地 deterministic 生成，不调用 AI", async () => {
  const store = new InMemoryStore();
  const rt = new FakeRuntime();
  const planner = new ItineraryOnlyPlanner();
  const result = await runPlan({ localProductId: "p", skeleton, store, runtime: rt, planner, providerLabel: "minimax" });
  assert.equal(result.status, "completed");
  assert.ok(!planner.calls.includes("research"), "research 阶段不应调用 planner");
  assert.ok(result.researchTasks.length >= 1, "research 阶段应当产出至少一条任务");
});

test("research 前用首个已验证 POI 补齐携程图库封面配置", async () => {
  const store = new InMemoryStore();
  const rt = new FakeRuntime();
  const result = await runPlan({ localProductId: "cover-default", skeleton, store, runtime: rt, planner: new ItineraryOnlyPlanner(), providerLabel: "minimax" });

  assert.equal(result.status, "completed");
  const cover = ((rt.product.presentation as Record<string, unknown>).cover ?? {}) as Record<string, unknown>;
  assert.equal(cover.source, "ctripLibrary");
  assert.equal(cover.poi, "晋祠博物馆（VBK）");
  assert.equal(cover.minQuality, 3);
  assert.ok(!rt.researchTasks.some((task) => task.type === "image"), "封面已补齐后不应再生成封面缺失任务");
});

test("presentation 缺失不阻塞 privateTour research 用车资源组任务", async () => {
  const store = new InMemoryStore();
  const rt = new FakeRuntime();
  const planner = new ItineraryOnlyPlanner({ failPresentation: true });

  const result = await runPlan({
    localProductId: "presentation-missing-research", skeleton, store, runtime: rt, planner, providerLabel: "minimax",
  });

  assert.equal(result.status, "needs_user");
  assert.ok(!result.state.completedStages.includes("presentation"), "presentation 失败时不能标记完成");
  assert.ok(result.state.completedStages.includes("commercial"), "commercial 成功结果应保留");
  assert.ok(result.state.completedStages.includes("research"), "research 应在 presentation 缺失时继续执行");
  assert.ok(!result.state.completedStages.includes("validation"), "presentation 缺失时不应进入最终 validation 完成态");
  assert.equal(result.state.currentStage, "presentation", "currentStage 应指回 presentation，方便继续补齐");
  assert.ok(result.researchTasks.some((task) => task.label === "核查用车资源组（按目的地 / 出行人数）"));
  assert.ok(rt.researchTasks.some((task) => task.label === "核查用车资源组（按目的地 / 出行人数）"));
  assert.ok(!planner.calls.includes("research"), "research 阶段不得调用 AI planner");
  assert.equal(planner.calls.filter((stage) => stage === "commercial").length, 1);
});

test("presentation 缺失后继续规划只补 presentation 并进入 validation", async () => {
  const store = new InMemoryStore();
  const rt = new FakeRuntime();
  const firstPlanner = new ItineraryOnlyPlanner({ failPresentation: true });

  await runPlan({
    localProductId: "presentation-missing-resume", skeleton, store, runtime: rt, planner: firstPlanner, providerLabel: "minimax",
  });

  const secondPlanner = new ItineraryOnlyPlanner();
  const result = await runPlan({
    localProductId: "presentation-missing-resume", skeleton, store, runtime: rt, planner: secondPlanner, providerLabel: "minimax",
  });

  assert.equal(result.status, "completed");
  assert.ok(result.state.completedStages.includes("presentation"), "resume 应补齐 presentation");
  assert.ok(result.state.completedStages.includes("validation"), "presentation 补齐后应进入 validation");
  assert.equal(secondPlanner.calls.filter((stage) => stage === "presentation").length, 1);
  assert.equal(secondPlanner.calls.filter((stage) => stage === "commercial").length, 0, "commercial 已完成，不应重跑");
  assert.ok(!secondPlanner.calls.includes("research"), "research 已完成且本地阶段不应调用 AI");
  assert.equal(rt.researchTasks.filter((task) => task.label === "核查用车资源组（按目的地 / 出行人数）").length, 1);
});

test("SuggestPoi 业务失败不会被降级成景点未匹配任务，且 itinerary 不完成", async () => {
  const store = new InMemoryStore();
  const rt = new FakeRuntime();
  rt.suggestPoi = async () => {
    throw new Error("VBK POI 查询业务失败");
  };

  const result = await runPlan({
    localProductId: "poi-business-failure",
    skeleton,
    store,
    runtime: rt,
    planner: new ItineraryOnlyPlanner(),
    providerLabel: "minimax",
  });

  assert.equal(result.status, "needs_user");
  assert.ok(!result.state.completedStages.includes("itinerary"), "POI 查询失败时 itinerary 不能标记完成");
  assert.equal(
    result.state.stages.find((stage) => stage.stage === "itinerary")?.accepted.some((item) => item.module === "itinerary"),
    false,
    "POI 查询失败时 itinerary 阶段也不能残留 accepted 记录",
  );
  assert.ok(
    !rt.researchTasks.some((task) => task.label.startsWith("待核查景点 ")),
    "接口失败必须可观察，不能伪装成 suggestPoi 未匹配",
  );
  assert.equal(
    rt.researchTasks.filter((task) => /VBK POI 映射$/.test(task.label)).length,
    0,
    "查询失败不是明确的未匹配，不能生成 canonical POI 核查项",
  );
});

test("SuggestPoi 未匹配与 itinerary 核查共用一个 canonical POI 待办", async () => {
  const store = new InMemoryStore();
  const rt = new FakeRuntime();
  rt.suggestPoi = async () => null;

  const result = await runPlan({ localProductId: "poi-no-match", skeleton, store, runtime: rt, planner: new ItineraryOnlyPlanner(), providerLabel: "minimax" });

  const poiTasks = rt.researchTasks.filter((task) => /VBK POI 映射$/.test(task.label));
  assert.equal(poiTasks.length, 4, "四个景点只应有四项待办，不能因未匹配再翻倍");
  assert.equal(result.status, "needs_user");
  assert.ok(!result.state.completedStages.includes("itinerary"), "未匹配 POI 不能让 itinerary 完成");
  assert.equal(
    result.state.stages.find((stage) => stage.stage === "itinerary")?.accepted.some((item) => item.module === "itinerary"),
    false,
    "未匹配 POI 时 itinerary 阶段也不能残留 accepted 记录",
  );
  assert.equal(new Set(poiTasks.map((task) => task.label)).size, 4);
  assert.ok(poiTasks.every((task) => task.label.startsWith("核查 ")));
});

test("research task 标签不包含「已确认 / 已解决」", async () => {
  const store = new InMemoryStore();
  const rt = new FakeRuntime();
  const planner = new ItineraryOnlyPlanner();
  const result = await runPlan({ localProductId: "p", skeleton, store, runtime: rt, planner, providerLabel: "minimax" });
  for (const task of result.researchTasks) {
    assert.ok(!/已确认|已解决|已完成|已通过/.test(task.label), `任务标签禁止「已确认」措辞：${task.label}`);
  }
});

test("planResearchTasks deterministic：同一输入两次产出完全一致", () => {
  const product = {
    operations: { hotelTier: "当地5钻酒店/-38" },
    itinerary: [
      { day: 1, spots: ["晋祠", "太原古县城"] },
      { day: 2, spots: [{ name: "山西博物院", poiName: null, poiId: null }] },
    ],
    commercial: {
      pricing: { adult: 1000, child: 500, minimumTravelers: 2, currency: "CNY" },
      inventory: { startDate: "2026-08-10", endDate: "2026-12-31", dailyQuota: 6 },
      packageName: "pkg",
      terms: { inclusions: "i", exclusions: "e", bookingNotes: "b", refundPolicy: "r" },
    },
  };
  const a = planResearchTasks({ skeleton, product, acceptedModules: ["skeleton", "itinerary", "presentation", "packageName", "pricing", "inventory", "terms", "release"] });
  const b = planResearchTasks({ skeleton, product, acceptedModules: ["skeleton", "itinerary", "presentation", "packageName", "pricing", "inventory", "terms", "release"] });
  assert.deepEqual(a, b);
  const labels = a.map((entry) => entry.proposal.label);
  assert.ok(!labels.some((label) => /成人价|儿童价|库存|套餐名称|费用包含|退改|成本口径/.test(label)));
});

test("planResearchTasks 不为已满足的用车 / 酒店字段新建任务", () => {
  const product = {
    operations: {
      hotelTier: "当地5钻酒店/-38",
      vehicleResource: { resourceGroupId: 2206240, resourceGroupName: "5座经济550+..." },
    },
    presentation: {
      cover: { source: "ctripLibrary", poi: "晋祠", description: "横版", minQuality: 3 },
    },
  };
  const pending = planResearchTasks({ skeleton, product, acceptedModules: ["skeleton", "presentation"] });
  const labels = pending.map((entry) => entry.proposal.label).join("\n");
  assert.ok(!/用车资源组|酒店/.test(labels), labels);
});

test("planResearchTasks 在用车 / 酒店字段缺失时仍生成资源核查任务", () => {
  const pending = planResearchTasks({ skeleton, product: { operations: { vehicleResource: {} } }, acceptedModules: ["skeleton"] });
  const labels = pending.map((entry) => entry.proposal.label);
  assert.ok(labels.some((label) => /用车资源组/.test(label)));
  assert.ok(labels.some((label) => /酒店/.test(label)));
});

test("pendingResearchTasks 会过滤掉已存在的任务", () => {
  const product = {
    operations: { hotelTier: "当地5钻酒店/-38" },
    itinerary: [{ day: 1, spots: [{ name: "晋祠", poiName: null, poiId: null }] }],
  };
  const accepted = ["skeleton", "itinerary"] as const;
  const existing = [{ label: "核查 晋祠 的 VBK POI 映射", type: "vbk" }];
  const pending = pendingResearchTasks({ skeleton, product, acceptedModules: accepted, existing });
  // 已存在的城市核查不应再被推为 pending。
  assert.ok(!pending.some((p) => p.proposal.label.includes("晋祠")), "已存在的任务不应再 pending");
});
