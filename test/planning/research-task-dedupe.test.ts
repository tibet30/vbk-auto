/**
 * Research task 全状态 dedupe 测试：
 *  - 已确认 / 已解决的 research task 同样不应在后续 planning:start / resume 上被重新生成；
 *  - DB / runtime 路径必须用「全状态」SQL filter 来去重 (label, type)；
 *  - pendingResearchTasks 必须把 confirmed / resolved 也视为已存在，避免重复提议。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { runPlan } from "../../src/main/planning/plan-orchestrator.js";
import { detectAcceptedModulesFromProduct } from "../../src/main/planning/runtime.js";
import { pendingResearchTasks } from "../../src/main/planning/research-tasks.js";
import type {
  GenerationStateStore, OrchestratorRuntime,
} from "../../src/main/planning/types.js";
import type {
  Planner, PlannerRequest, PlanningStageOutput, PlanningGenerationState, PlanningModule, PlanningStage, ResearchTaskProposal,
} from "../../src/shared/contracts-planning.js";
import { AI_WRITABLE_PATHS } from "../../src/main/planning/schemas.js";

class ItineraryOnlyPlanner implements Planner {
  calls: PlanningStage[] = [];
  async generateStage(request: PlannerRequest): Promise<PlanningStageOutput> {
    this.calls.push(request.stage);
    if (request.stage === "itinerary") {
      return {
        reply: "itin",
        modules: [{ module: "itinerary", status: "accepted", value: [
          { day: 1, title: "D1", spots: ["晋祠", "太原古县城"], description: "D", hotel: "H", meals: "B/L/D" },
          { day: 2, title: "D2", spots: ["山西博物院", "晋商博物院"], description: "D", hotel: "", meals: "B/L/D" },
        ] }],
      };
    }
    if (request.stage === "presentation") {
      return { reply: "p", modules: [{ module: "presentation", status: "accepted", value: {
        recommendationCategory: "优选行程",
        recommendation: "R",
        recommendations: [
          { category: "优选行程", text: "a" }, { category: "精选酒店", text: "b" }, { category: "缤纷景点", text: "c" },
        ],
        features: "f",
      } }] };
    }
    if (request.stage === "commercial") {
      return { reply: "c", modules: [
        { module: "pricing", status: "accepted", value: { currency: "CNY", adult: 1233, child: 673, minimumTravelers: 2 } },
        { module: "inventory", status: "accepted", value: { startDate: "2026-08-10", endDate: "2026-12-31", dailyQuota: 6 } },
        { module: "terms", status: "accepted", value: { inclusions: "i", exclusions: "e", bookingNotes: "b", refundPolicy: "r" } },
        { module: "release", status: "accepted", value: { submitReview: false, publishAfterApproval: false, publicPriceCeiling: 3000, publicAuditRetries: 4 } },
      ] };
    }
    throw new Error("unexpected " + request.stage);
  }
}

class InMemoryStore implements GenerationStateStore {
  state?: PlanningGenerationState;
  load() { return Promise.resolve(this.state); }
  save(s: PlanningGenerationState) { this.state = s; return Promise.resolve(); }
}

interface ResearchTaskRow {
  label: string;
  type: string;
  state: "queued" | "researching" | "confirmed" | "resolved";
}

class FakeRuntime implements OrchestratorRuntime {
  product: Record<string, unknown> = { basicInfo: { province: "山西" } };
  /** DB-style task list, including all states. */
  tasks: ResearchTaskRow[] = [];
  private keys = new Set<string>();
  async loadExistingResearchTasks(): Promise<Array<Pick<ResearchTaskProposal, "label" | "type">>> {
    // 全状态 dedupe：包含 confirmed / resolved 也视作已存在。
    return this.tasks.map((t) => ({ label: t.label, type: t.type as ResearchTaskProposal["type"] }));
  }
  async writeModule(_id: string, _m: PlanningModule, path: string, value: unknown) {
    if (path === AI_WRITABLE_PATHS.skeleton) {
      this.product = { ...this.product, operations: { ...(this.product.operations as object | undefined ?? {}), ...(value as object) } };
      return { ok: true };
    }
    const segs = path.split("/").slice(1);
    const next = structuredClone(this.product) as Record<string, unknown>;
    let parent = next;
    for (let i = 0; i < segs.length - 1; i += 1) parent = (parent[segs[i]] ??= {}) as Record<string, unknown>;
    parent[segs.at(-1)!] = value;
    this.product = next;
    return { ok: true };
  }
  async addResearchTask(_id: string, task: ResearchTaskProposal) {
    // 全状态 dedupe：state 不再参与 filter；同 (label, type) 直接视为同一任务。
    const key = `${task.type}::${task.label}`;
    if (!this.keys.has(key)) {
      this.keys.add(key);
      this.tasks.push({ label: task.label, type: task.type, state: "researching" });
    }
    return key;
  }
  async loadHistory() { return []; }
  async loadCurrentProduct() { return this.product; }
  async loadAcceptedModules(): Promise<PlanningModule[]> {
    return detectAcceptedModulesFromProduct({
      basicInfo: { days: 2, nights: 1, supplierProductCode: "NEW" },
      ...this.product,
    });
  }
}

const skeleton = { destination: "太原", days: 2, nights: 1, productForm: "privateTour" as const, productType: "domesticShort" as const, supplierProductCode: "NEW" };

test("confirmed / resolved 的 research task 不被新一轮 planning 重新生成", async () => {
  const store = new InMemoryStore();
  const rt = new FakeRuntime();
  // 预先在 DB 里放一条 confirmed 状态的 city-poi 核查：运营已经在 VBK 上确认过。
  rt.tasks.push({ label: "核查 晋祠 的 VBK POI 映射", type: "vbk", state: "confirmed" });
  // planning:start → research 阶段会基于 itinerary 提议 city-poi 核查；
  // 因为该任务已 confirmed，pendingResearchTasks 必须 filter 掉。
  const planner = new ItineraryOnlyPlanner();
  await runPlan({ localProductId: "p", skeleton, store, runtime: rt, planner, providerLabel: "minimax" });
  // FakeRuntime 跟踪到的 tasks：原始 1 条 + 真正 pending 的（比如山西博物院 / 晋商博物院 / 用车 / 酒店等）；
  // 晋祠这条不应再被添加（重复）。
  const labels = rt.tasks.map((t) => t.label);
  const jinci = labels.filter((l) => l.includes("晋祠"));
  assert.equal(jinci.length, 1, `晋祠核查应只出现一次（confirmed 已占用），实际：${labels.join(" | ")}`);
});

test("research 阶段 deterministic：confirmed 任务与未完成任务的混合列表上第二轮不再生成已有标签", async () => {
  // pendingResearchTasks 的纯函数路径：模拟 planningResume 时已有 task 列表。
  const product = {
    basicInfo: { days: 2, nights: 1, supplierProductCode: "NEW" },
    operations: { hotelTier: "当地5钻酒店/-38" },
    itinerary: [
      { day: 1, spots: [{ name: "晋祠", poiName: null, poiId: null }] },
      { day: 2, spots: [{ name: "山西博物院", poiName: null, poiId: null }] },
    ],
    commercial: {
      pricing: { adult: 1000, child: 500, minimumTravelers: 2, currency: "CNY" },
      inventory: { startDate: "2026-08-10", endDate: "2026-12-31", dailyQuota: 6 },
      packageName: "pkg",
      terms: { inclusions: "i", exclusions: "e", bookingNotes: "b", refundPolicy: "r" },
    },
  };
  const accepted = ["skeleton", "itinerary", "packageName", "pricing", "inventory", "terms", "release"] as const;
  // existing 含一条 confirmed 状态的晋祠核查 → 应当 filter 掉。
  const existing: Array<Pick<ResearchTaskProposal, "label" | "type">> = [
    { label: "核查 晋祠 的 VBK POI 映射", type: "vbk" },
  ];
  const pending = pendingResearchTasks({ skeleton, product, acceptedModules: accepted, existing });
  assert.ok(!pending.some((p) => p.proposal.label.includes("晋祠")), "confirmed 状态的晋祠核查已被 dedupe");
  // 景点任务已迁移到 itinerary 接受后生成，research 纯函数不再产生 POI。
  assert.ok(!pending.some((p) => p.proposal.label.includes("山西博物院")), "research 不应再生成景点任务");
});

test("runtime.addResearchTask 在 SQL 全状态 filter 下不创建重复条目", async () => {
  // 模拟 SQL 行为：runtime.addResearchTask 不论 state 都 dedupe。
  const store = new InMemoryStore();
  const rt = new FakeRuntime();
  rt.tasks.push({ label: "核查 X", type: "vbk", state: "confirmed" });
  const planner = new ItineraryOnlyPlanner();
  await runPlan({ localProductId: "p", skeleton, store, runtime: rt, planner, providerLabel: "minimax" });
  // 整个 plan 跑完，tasks 不应有任何重复 (label, type)。
  const keys = rt.tasks.map((t) => `${t.type}::${t.label}`);
  const seen = new Set<string>();
  for (const k of keys) {
    assert.ok(!seen.has(k), `重复的 research task：${k}`);
    seen.add(k);
  }
});
