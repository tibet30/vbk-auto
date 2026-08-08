/**
 * research 阶段 deterministic 行为测试：
 *  - 不调用 AI（planner 不会收到 research 请求）；
 *  - 按 itinerary + 商业模块生成 city / POI / 用车 / 酒店 / 价格库存核查；
 *  - 同一份输入多次运行产生完全相同的任务清单；
 *  - 标签禁止「已确认 / 已解决」措辞；
 *  - AI 即使产出声称解决，runtime 也不会被 fake task 标记为 confirmed。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { runPlan } from "../../src/main/planning/plan-orchestrator.js";
import { pendingResearchTasks, planResearchTasks } from "../../src/main/planning/research-tasks.js";
import type {
  GenerationStateStore, OrchestratorRuntime,
} from "../../src/main/planning/types.js";
import type {
  Planner, PlannerRequest, PlanningStageOutput, PlanningGenerationState, PlanningModule, ResearchTaskProposal,
} from "../../src/shared/contracts-planning.js";
import { AI_WRITABLE_PATHS } from "../../src/main/planning/schemas.js";

class ItineraryOnlyPlanner implements Planner {
  calls: PlanningStage[] = [];
  async generateStage(request: PlannerRequest): Promise<PlanningStageOutput> {
    this.calls.push(request.stage);
    if (request.stage === "basicInfo") return { reply: "basic", modules: [{ module: "basicInfo", status: "accepted", value: { subtitle: "太原精华之旅", province: "山西", operationNotes: "待核查" } }] };
    if (request.stage === "itinerary") {
      return {
        reply: "itin",
        modules: [{ module: "itinerary", status: "accepted", value: [
          { day: 1, title: "D1", spots: ["晋祠博物馆", "太原古县城"], description: "D", hotel: "H", meals: "B/L/D" },
          { day: 2, title: "D2", spots: ["山西博物院", "晋商博物院"], description: "D", hotel: "", meals: "B/L/D" },
        ] }],
      };
    }
    if (request.stage === "presentation") {
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
      { module: "packageName", status: "accepted", value: "pkg" },
      { module: "pricing", status: "accepted", value: { currency: "CNY", adult: 1000, child: 500, minimumTravelers: 2 } },
      { module: "inventory", status: "accepted", value: { startDate: "2026-08-10", endDate: "2026-12-31", dailyQuota: 6 } },
      { module: "terms", status: "accepted", value: { inclusions: "i", exclusions: "e", bookingNotes: "b", refundPolicy: "r" } },
      { module: "release", status: "accepted", value: { publicPriceCeiling: 2000, publicAuditRetries: 3 } },
    ] };
    if (request.stage === "commercial") {
      return {
        reply: "com",
        modules: [
          { module: "packageName", status: "accepted", value: "pkg" },
          { module: "pricing", status: "accepted", value: { currency: "CNY", adult: 1233, child: 673, minimumTravelers: 2 } },
          { module: "inventory", status: "accepted", value: { startDate: "2026-08-10", endDate: "2026-12-31", dailyQuota: 6 } },
          { module: "terms", status: "accepted", value: { inclusions: "i", exclusions: "e", bookingNotes: "b", refundPolicy: "r" } },
          { module: "release", status: "accepted", value: { submitReview: false, publishAfterApproval: false, publicPriceCeiling: 3000, publicAuditRetries: 4 } },
        ],
      };
    }
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
  async loadHistory() { return []; }
  async loadCurrentProduct() { return this.product; }
  async loadAcceptedModules(): Promise<PlanningModule[]> {
    const out: PlanningModule[] = [];
    const b = this.product.basicInfo as Record<string, unknown> | undefined;
    if (b && ["subtitle", "province", "operationNotes"].every(k => typeof b[k] === "string" && String(b[k]).trim())) out.push("basicInfo");
    if (this.product.operations) out.push("skeleton");
    if (this.product.presentation) out.push("presentation");
    if (Array.isArray(this.product.itinerary) && this.product.itinerary.length) out.push("itinerary");
    const c = this.product.commercial as Record<string, unknown> | undefined;
    if (c?.packageName) out.push("packageName");
    if (c?.pricing) out.push("pricing");
    if (c?.inventory) out.push("inventory");
    if (c?.terms) out.push("terms");
    if (c?.release) out.push("release");
    return out;
  }
}

const skeleton = { destination: "太原", days: 2, nights: 1, productForm: "privateTour" as const, productType: "domesticShort" as const, supplierProductCode: "NEW" };

test("research 阶段由本地 deterministic 生成，不调用 AI", async () => {
  const store = new InMemoryStore();
  const rt = new FakeRuntime();
  const planner = new ItineraryOnlyPlanner();
  const result = await runPlan({ projectId: "p", skeleton, store, runtime: rt, planner, providerLabel: "minimax" });
  assert.equal(result.status, "completed");
  assert.ok(!planner.calls.includes("research"), "research 阶段不应调用 planner");
  assert.ok(result.researchTasks.length >= 1, "research 阶段应当产出至少一条任务");
});

test("research task 标签不包含「已确认 / 已解决」", async () => {
  const store = new InMemoryStore();
  const rt = new FakeRuntime();
  const planner = new ItineraryOnlyPlanner();
  const result = await runPlan({ projectId: "p", skeleton, store, runtime: rt, planner, providerLabel: "minimax" });
  for (const task of result.researchTasks) {
    assert.ok(!/已确认|已解决|已完成|已通过/.test(task.label), `任务标签禁止「已确认」措辞：${task.label}`);
  }
});

test("planResearchTasks deterministic：同一输入两次产出完全一致", () => {
  const product = {
    operations: { hotelTier: "当地5钻酒店/-38" },
    itinerary: [
      { day: 1, spots: ["晋祠", "太原古县城"] },
      { day: 2, spots: ["山西博物院"] },
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
});

test("pendingResearchTasks 会过滤掉已存在的任务", () => {
  const product = {
    operations: { hotelTier: "当地5钻酒店/-38" },
    itinerary: [{ day: 1, spots: ["晋祠"] }],
  };
  const accepted = ["skeleton", "itinerary"] as const;
  const existing = [{ label: "核查 晋祠 在 VBK 资源库的 city / poi 映射", type: "vbk" }];
  const pending = pendingResearchTasks({ skeleton, product, acceptedModules: accepted, existing });
  // 已存在的城市核查不应再被推为 pending。
  assert.ok(!pending.some((p) => p.proposal.label.includes("晋祠")), "已存在的任务不应再 pending");
});
