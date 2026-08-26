/**
 * end-to-end orchestration test with a fake provider.
 *
 * 该测试**不调用真实 provider**，通过 stub Planner 模拟每个阶段的成功输出，
 * 验证：
 *  - 阶段顺序：skeleton → itinerary → presentation → commercial → research → validation；
 *  - 持久化状态 + 持久化产品共同决定 completeness；
 *  - assistant 回复基于「实际接受 / 缺失模块」，不信任模型声称；
 *  - 每个阶段的 Planner 调用次数 = 1（adapter 自己重试次数独立计算）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { runPlan } from "../../src/main/planning/plan-orchestrator.js";
import {
  AI_WRITABLE_PATHS,
} from "../../src/main/planning/schemas.js";
import { detectAcceptedModulesFromProduct } from "../../src/main/planning/runtime.js";
import type {
  GenerationStateStore,
  OrchestratorRuntime,
} from "../../src/main/planning/types.js";
import type {
  Planner,
  PlannerRequest,
  PlanningStageOutput,
  PlanningGenerationState,
  PlanningModule,
  PlanningStage,
  ResearchTaskProposal,
} from "../../src/shared/contracts-planning.js";
import { PLANNING_STAGES } from "../../src/shared/contracts-planning.js";

interface FakeProviderScript {
  stage: PlanningStage;
  output: PlanningStageOutput;
  /** 该阶段被调用次数（用于请求计数断言）。 */
  callCount: number;
}

class FakePlanner implements Planner {
  calls: { stage: PlanningStage; attempt: number }[] = [];
  private readonly script: FakeProviderScript[];
  /** 让 itinerary 阶段失败 N 次，再成功一次。 */
  private itineraryRetry = 0;
  constructor(script: FakeProviderScript[]) {
    this.script = script;
  }
  async generateStage(request: PlannerRequest): Promise<PlanningStageOutput> {
    this.calls.push({ stage: request.stage, attempt: (request.previousError?.attempt ?? 0) + 1 });
    const entry = this.script.find((s) => s.stage === request.stage);
    if (!entry) throw new Error(`未编排阶段 ${request.stage} 的 fake 输出`);
    if (request.stage === "itinerary" && this.itineraryRetry > 0) {
      this.itineraryRetry -= 1;
      throw new Error("模拟 itinerary 失败一次");
    }
    entry.callCount += 1;
    return entry.output;
  }
}

class InMemoryStore implements GenerationStateStore {
  state?: PlanningGenerationState;
  snapshots: PlanningGenerationState[] = [];
  load(): Promise<PlanningGenerationState | undefined> { return Promise.resolve(this.state); }
  save(state: PlanningGenerationState): Promise<void> {
    // 编排器会原地推进 state；记录深拷贝才能检验每次实际落盘的快照。
    this.state = structuredClone(state);
    this.snapshots.push(structuredClone(state));
    return Promise.resolve();
  }
}

class FakeRuntime implements OrchestratorRuntime {
  // skeleton 阶段只负责补副标题/运营备注；省份必须来自已确认的基础信息，
  // 不能把目的地城市伪造成省份。用真实产品已有的山西省份模拟该前置事实。
  product: Record<string, unknown> = { basicInfo: { province: "山西" } };
  researchTasks: ResearchTaskProposal[] = [];
  history: Array<{ role: "user" | "assistant"; content: string }> = [];
  /** addResearchTask 去重语义：相同 label+type 只算一次。 */
  private taskKeys = new Set<string>();
  moduleWrites: Array<{ module: PlanningModule; writePath: string }> = [];
  suggestPoi = async (keyword: string) => ({ poiName: `${keyword}（VBK）`, poiId: 1000 });
  async loadExistingResearchTasks(): Promise<Array<Pick<ResearchTaskProposal, "label" | "type">>> {
    return this.researchTasks.map((t) => ({ label: t.label, type: t.type }));
  }
  async writeModule(_localProductId: string, _module: PlanningModule, writePath: string, value: unknown): Promise<{ ok: boolean; reason?: string }> {
    this.moduleWrites.push({ module: _module, writePath });
    if (writePath === AI_WRITABLE_PATHS.presentation || writePath === AI_WRITABLE_PATHS.itinerary
        || writePath === AI_WRITABLE_PATHS.packageName || writePath === AI_WRITABLE_PATHS.pricing
        || writePath === AI_WRITABLE_PATHS.inventory || writePath === AI_WRITABLE_PATHS.terms
        || writePath === AI_WRITABLE_PATHS.release) {
      this.product = applyPatch(this.product, writePath, value);
      return { ok: true };
    }
    if (writePath === AI_WRITABLE_PATHS.skeleton) {
      this.product = { ...this.product, operations: { ...(this.product.operations as object | undefined ?? {}), ...(value as object) } };
      return { ok: true };
    }
    if (writePath === AI_WRITABLE_PATHS.basicInfo) {
      this.product = { ...this.product, basicInfo: { ...(this.product.basicInfo as object | undefined ?? {}), ...(value as object) } };
      return { ok: true };
    }
    return { ok: false, reason: `unknown writePath ${writePath}` };
  }
  async addResearchTask(_localProductId: string, task: ResearchTaskProposal): Promise<string> {
    const key = `${task.type}::${task.label}`;
    if (!this.taskKeys.has(key)) {
      this.taskKeys.add(key);
      this.researchTasks.push(task);
    }
    return key;
  }
  async loadHistory(): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
    return this.history;
  }
  async loadCurrentProduct(): Promise<Record<string, unknown>> {
    return this.product;
  }
  async loadAcceptedModules(): Promise<PlanningModule[]> {
    return detectAcceptedModulesFromProduct(this.product);
  }
}

function applyPatch(product: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const segments = path.split("/").slice(1);
  const result = structuredClone(product) as Record<string, unknown>;
  let parent: Record<string, unknown> = result;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const key = segments[i];
    if (!parent[key] || typeof parent[key] !== "object") parent[key] = {};
    parent = parent[key] as Record<string, unknown>;
  }
  parent[segments.at(-1)!] = value;
  return result;
}

const skeleton = {
  destination: "太原",
  days: 2,
  nights: 1,
  productForm: "privateTour" as const,
  productType: "domesticShort" as const,
  supplierProductCode: "VBK-20260101-NEW001",
};

function buildFakeScript(): FakeProviderScript[] {
  return [
    { stage: "basicInfo", callCount: 0, output: { reply: "已生成基础信息", modules: [{ module: "basicInfo", status: "accepted", value: { subtitle: "太原精华之旅", province: "山西", operationNotes: "待核查" } }] } },
    {
      stage: "itinerary",
      callCount: 0,
      output: {
        reply: "已生成 2 天行程",
        modules: [{
          module: "itinerary",
          status: "accepted",
          value: [
            { day: 1, title: "太原接站—晋祠", spots: [{ name: "晋祠博物馆", poiName: null, poiId: null }], description: "专车接站游览晋祠。", hotel: "太原市区舒适酒店", meals: "早餐自理；午餐自理；晚餐自理" },
            { day: 2, title: "山西博物院—送站", spots: [{ name: "山西博物院", poiName: null, poiId: null }], description: "上午山西博物院，下午送站。", hotel: "", meals: "含早餐；午餐自理；晚餐自理" },
          ],
        }],
      },
    },
    {
      stage: "presentation",
      callCount: 0,
      output: {
        reply: "已生成 presentation",
        modules: [{
          module: "presentation",
          status: "accepted",
          value: {
            recommendationCategory: "优选行程",
            recommendation: "2 天串联核心景点",
            recommendations: [
              { category: "服务保障", text: "节奏舒适不赶路" },
              { category: "精选酒店", text: "当地 3 钻酒店含早餐" },
              { category: "贴心赠送", text: "覆盖晋祠与博物院" },
            ],
            features: "【古建巡礼】专业讲解\n【私享出行】独立成团",
          },
        }],
      },
    },
    {
      stage: "commercial",
      callCount: 0,
      output: {
        reply: "已生成 commercial 模块",
        modules: [
          {
            module: "pricing", status: "accepted",
            value: { currency: "CNY", adult: 1233, child: 673, minimumTravelers: 2 },
          },
          {
            module: "inventory", status: "accepted",
            value: { startDate: "2026-08-10", endDate: "2026-12-31", dailyQuota: 6 },
          },
          {
            module: "release", status: "accepted",
            // 即便模型写 true，sanitise 会强制 false。
            value: { submitReview: true, publishAfterApproval: true, publicPriceCeiling: 3000, publicAuditRetries: 4 },
          },
        ],
      },
    },
    // research 阶段由本地 deterministic 生成，不在脚本里。
  ];
}

test("完整 staged planning 跑完后状态为 completed", async () => {
  const store = new InMemoryStore();
  const runtime = new FakeRuntime();
  const planner = new FakePlanner(buildFakeScript());
  const result = await runPlan({
    localProductId: "p1", skeleton, store, runtime, planner, providerLabel: "minimax",
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.state.completedStages, ["skeleton", "basicInfo", "itinerary", "presentation", "commercial", "research", "validation"]);
  // accepted 包含所有 planning REQUIRED + skeleton。terms 由 VBK 条款阶段处理。
  const acceptedModules = result.accepted.map((m) => m.module).sort();
  assert.deepEqual(acceptedModules, ["basicInfo", "inventory", "itinerary", "packageName", "presentation", "pricing", "release", "skeleton"]);
  // research tasks 仍被记录到 result.researchTasks。
  assert.ok(result.researchTasks.length >= 1);
  assert.equal(result.rejected.length, 0);
});

test("阶段成功的持久化快照原子推进到下一阶段，期间不暴露 completed", async () => {
  const store = new InMemoryStore();
  const runtime = new FakeRuntime();
  const planner = new FakePlanner(buildFakeScript());
  await runPlan({ localProductId: "progress-atomic", skeleton, store, runtime, planner, providerLabel: "minimax" });

  // 首个 running 快照用于宣告起跑；随后每一个 save 都是实际会被 renderer
  // 轮询到的持久化状态，必须原子完成「标记前一阶段完成 + 推进下一阶段」。
  // 不使用状态对象的引用，InMemoryStore.save 已 structuredClone，避免后续原地
  // 修改把历史快照伪装成正确结果。
  const expectedProgressSnapshots: Array<{
    completedStages: PlanningStage[];
    currentStage: PlanningStage;
    status: "running" | "completed";
  }> = [
    { completedStages: [], currentStage: "skeleton", status: "running" },
    { completedStages: ["skeleton"], currentStage: "basicInfo", status: "running" },
    { completedStages: ["skeleton", "basicInfo"], currentStage: "itinerary", status: "running" },
    { completedStages: ["skeleton", "basicInfo", "itinerary"], currentStage: "presentation", status: "running" },
    // presentation / commercial 并行阶段收敛后只落一次快照，不能先暴露任一
    // 子阶段的 completed，也不能产生多余的中间 save。
    { completedStages: ["skeleton", "basicInfo", "itinerary", "presentation", "commercial"], currentStage: "research", status: "running" },
    { completedStages: ["skeleton", "basicInfo", "itinerary", "presentation", "commercial", "research"], currentStage: "validation", status: "running" },
    { completedStages: PLANNING_STAGES.slice(), currentStage: "validation", status: "running" },
    { completedStages: PLANNING_STAGES.slice(), currentStage: "validation", status: "completed" },
  ];
  assert.equal(store.snapshots.length, expectedProgressSnapshots.length, "成功路径不得额外持久化中间快照");
  assert.deepEqual(
    store.snapshots.map(({ completedStages, currentStage, status }) => ({ completedStages, currentStage, status })),
    expectedProgressSnapshots,
  );
});

test("release.submitReview / publishAfterApproval 即使模型写 true 也会被强制 false", async () => {
  const store = new InMemoryStore();
  const runtime = new FakeRuntime();
  const planner = new FakePlanner(buildFakeScript());
  await runPlan({ localProductId: "p2", skeleton, store, runtime, planner, providerLabel: "minimax" });
  const release = (runtime.product.commercial as { release: { submitReview: boolean; publishAfterApproval: boolean } }).release;
  assert.equal(release.submitReview, false);
  assert.equal(release.publishAfterApproval, false);
});

test("每个阶段的 Planner 调用次数 = 1，不存在嵌套 25-call retry", async () => {
  const store = new InMemoryStore();
  const runtime = new FakeRuntime();
  const planner = new FakePlanner(buildFakeScript());
  await runPlan({ localProductId: "p3", skeleton, store, runtime, planner, providerLabel: "minimax" });
  // skeleton / research / validation 由本地完成，planner 不被调用；
  // itinerary / presentation / commercial 各调用 1 次。
  assert.equal(planner.calls.filter((c) => c.stage === "itinerary").length, 1);
  assert.equal(planner.calls.filter((c) => c.stage === "presentation").length, 1);
  assert.equal(planner.calls.filter((c) => c.stage === "commercial").length, 1);
  assert.equal(planner.calls.filter((c) => c.stage === "basicInfo").length, 1);
  assert.ok(!planner.calls.some((c) => c.stage === "research"), "research 阶段是本地 deterministic，不调用 planner");
  assert.equal(planner.calls.length, 4, "总调用次数 = 4（不含 skeleton / research / validation）");
});

test("research tasks 由本地 deterministic 生成，标签不含「已确认 / 已解决」", async () => {
  const store = new InMemoryStore();
  const runtime = new FakeRuntime();
  const planner = new FakePlanner(buildFakeScript());
  const result = await runPlan({ localProductId: "p4", skeleton, store, runtime, planner, providerLabel: "minimax" });
  assert.ok(result.researchTasks.length >= 1, "research 阶段应当产出至少 1 条任务");
  for (const task of result.researchTasks) {
    assert.ok(!/已确认|已解决|已完成|已通过/.test(task.label), `research task 标签禁止「已确认」措辞：${task.label}`);
  }
});

test("续跑时已完成阶段被跳过，且不重跑 planner", async () => {
  const store = new InMemoryStore();
  const runtime = new FakeRuntime();
  const planner = new FakePlanner(buildFakeScript());
  // 第一次跑完。
  await runPlan({ localProductId: "p5", skeleton, store, runtime, planner, providerLabel: "minimax" });
  const firstCalls = planner.calls.length;
  // 第二次跑（模拟重启后 resume）：应当立即判定 completed，不调用 planner。
  const planner2 = new FakePlanner(buildFakeScript());
  const result2 = await runPlan({ localProductId: "p5", skeleton, store, runtime, planner: planner2, providerLabel: "minimax" });
  assert.equal(result2.status, "completed");
  assert.equal(planner2.calls.length, 0, "resume 不应再调 planner");
  assert.equal(firstCalls, 4);
});

test("已完成方案若 POI 被打坏，续跑会回退 itinerary 并补齐后再完成", async () => {
  const store = new InMemoryStore();
  const runtime = new FakeRuntime();
  await runPlan({
    localProductId: "completed-poi-backfill", skeleton, store, runtime,
    planner: new FakePlanner(buildFakeScript()), providerLabel: "minimax",
  });
  const itinerary = runtime.product.itinerary as Array<{ spots: Array<{ name: string; poiName: string | null; poiId: number | null }> }>;
  itinerary[0].spots[0].poiName = null;
  itinerary[0].spots[0].poiId = null;
  itinerary[1].spots[0].poiName = null;
  itinerary[1].spots[0].poiId = null;
  runtime.moduleWrites = [];
  const queried: string[] = [];
  runtime.suggestPoi = async (keyword) => {
    queried.push(keyword);
    return { poiName: `${keyword}（VBK）`, poiId: 79413 };
  };
  const planner = new FakePlanner(buildFakeScript());

  const result = await runPlan({
    localProductId: "completed-poi-backfill", skeleton, store, runtime, planner, providerLabel: "minimax",
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(result.state.completedStages, PLANNING_STAGES);
  assert.deepEqual(queried, ["晋祠博物馆", "山西博物院"]);
  assert.deepEqual(planner.calls.map((call) => call.stage), ["itinerary", "commercial"], "缺 POI 的 completed 产品必须回退重跑 itinerary，并重新经过下游阶段门");
  assert.deepEqual(runtime.moduleWrites.filter((write) => write.module === "itinerary"), [
    { module: "itinerary", writePath: AI_WRITABLE_PATHS.itinerary },
    { module: "itinerary", writePath: AI_WRITABLE_PATHS.itinerary },
  ]);
  const fixed = runtime.product.itinerary as Array<{ spots: Array<{ poiName: string | null; poiId: number | null }> }>;
  assert.deepEqual(fixed[0].spots[0], { name: "晋祠博物馆", poiName: "晋祠博物馆（VBK）", poiId: 79413 });
  assert.deepEqual(fixed[1].spots[0], { name: "山西博物院", poiName: "山西博物院（VBK）", poiId: 79413 });
});

test("已完成方案的 POI 已齐全时续跑不查询也不重写行程", async () => {
  const store = new InMemoryStore();
  const runtime = new FakeRuntime();
  await runPlan({
    localProductId: "completed-poi-complete", skeleton, store, runtime,
    planner: new FakePlanner(buildFakeScript()), providerLabel: "minimax",
  });
  const itinerary = runtime.product.itinerary as Array<{ spots: Array<{ poiName: string | null; poiId: number | null }> }>;
  for (const day of itinerary) {
    for (const spot of day.spots) {
      spot.poiName = spot.poiName ?? "已核验景点";
      spot.poiId = spot.poiId ?? 1;
    }
  }
  runtime.moduleWrites = [];
  let queryCount = 0;
  runtime.suggestPoi = async () => {
    queryCount += 1;
    return null;
  };

  const result = await runPlan({
    localProductId: "completed-poi-complete", skeleton, store, runtime,
    planner: new FakePlanner(buildFakeScript()), providerLabel: "minimax",
  });

  assert.equal(result.status, "completed");
  assert.equal(queryCount, 0);
  assert.deepEqual(runtime.moduleWrites, []);
});

test("assistant 回复反映实际接受 / 缺失模块，不抄模型 reply", async () => {
  const store = new InMemoryStore();
  const runtime = new FakeRuntime();
  const planner = new FakePlanner(buildFakeScript());
  const result = await runPlan({ localProductId: "p6", skeleton, store, runtime, planner, providerLabel: "minimax" });
  // 模型在 presentation 阶段写过「已生成 presentation」；orchestrator 的回复应当不抄。
  assert.ok(!result.assistantReply.includes("已生成 presentation"), `assistant reply 不应抄模型字符串：${result.assistantReply}`);
  assert.ok(result.assistantReply.includes("完成"));
});
