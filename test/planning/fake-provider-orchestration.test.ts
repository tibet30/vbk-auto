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
  load(): Promise<PlanningGenerationState | undefined> { return Promise.resolve(this.state); }
  save(state: PlanningGenerationState): Promise<void> { this.state = state; return Promise.resolve(); }
}

class FakeRuntime implements OrchestratorRuntime {
  product: Record<string, unknown> = {};
  researchTasks: ResearchTaskProposal[] = [];
  history: Array<{ role: "user" | "assistant"; content: string }> = [];
  /** addResearchTask 去重语义：相同 label+type 只算一次。 */
  private taskKeys = new Set<string>();
  async loadExistingResearchTasks(): Promise<Array<Pick<ResearchTaskProposal, "label" | "type">>> {
    return this.researchTasks.map((t) => ({ label: t.label, type: t.type }));
  }
  async writeModule(_projectId: string, _module: PlanningModule, writePath: string, value: unknown): Promise<{ ok: boolean; reason?: string }> {
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
    return { ok: false, reason: `unknown writePath ${writePath}` };
  }
  async addResearchTask(_projectId: string, task: ResearchTaskProposal): Promise<string> {
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
    {
      stage: "itinerary",
      callCount: 0,
      output: {
        reply: "已生成 2 天行程",
        modules: [{
          module: "itinerary",
          status: "accepted",
          value: [
            { day: 1, title: "太原接站—晋祠", spots: ["晋祠博物馆"], description: "专车接站游览晋祠。", hotel: "太原市区舒适酒店", meals: "早餐自理；午餐自理；晚餐自理" },
            { day: 2, title: "山西博物院—送站", spots: ["山西博物院"], description: "上午山西博物院，下午送站。", hotel: "", meals: "含早餐；午餐自理；晚餐自理" },
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
              { category: "优选行程", text: "节奏舒适不赶路" },
              { category: "精选酒店", text: "当地 3 钻酒店含早餐" },
              { category: "缤纷景点", text: "覆盖晋祠与博物院" },
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
        reply: "已生成 commercial 五件套",
        modules: [
          { module: "packageName", status: "accepted", value: "太原 2 天 1 晚私家团标准套餐" },
          {
            module: "pricing", status: "accepted",
            value: { currency: "CNY", adult: 1233, child: 673, minimumTravelers: 2 },
          },
          {
            module: "inventory", status: "accepted",
            value: { startDate: "2026-08-10", endDate: "2026-12-31", dailyQuota: 6 },
          },
          {
            module: "terms", status: "accepted",
            value: {
              inclusions: "行程内专车、住宿、行程规划。",
              exclusions: "门票、讲解、餐饮、单房差。",
              bookingNotes: "至少 2 人起订，建议提前 1 天 15 时前预订。",
              refundPolicy: "资源确认前无损取消；确认后按实际损失扣除。",
            },
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
    projectId: "p1", skeleton, store, runtime, planner, providerLabel: "minimax",
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.state.completedStages, ["skeleton", "itinerary", "presentation", "commercial", "research", "validation"]);
  // accepted 包含所有 REQUIRED + skeleton。researchTasks 由 ResearchTaskProposal 列表单独暴露。
  const acceptedModules = result.accepted.map((m) => m.module).sort();
  assert.deepEqual(acceptedModules, ["inventory", "itinerary", "packageName", "presentation", "pricing", "release", "skeleton", "terms"]);
  // research tasks 仍被记录到 result.researchTasks。
  assert.ok(result.researchTasks.length >= 1);
  assert.equal(result.rejected.length, 0);
});

test("release.submitReview / publishAfterApproval 即使模型写 true 也会被强制 false", async () => {
  const store = new InMemoryStore();
  const runtime = new FakeRuntime();
  const planner = new FakePlanner(buildFakeScript());
  await runPlan({ projectId: "p2", skeleton, store, runtime, planner, providerLabel: "minimax" });
  const release = (runtime.product.commercial as { release: { submitReview: boolean; publishAfterApproval: boolean } }).release;
  assert.equal(release.submitReview, false);
  assert.equal(release.publishAfterApproval, false);
});

test("每个阶段的 Planner 调用次数 = 1，不存在嵌套 25-call retry", async () => {
  const store = new InMemoryStore();
  const runtime = new FakeRuntime();
  const planner = new FakePlanner(buildFakeScript());
  await runPlan({ projectId: "p3", skeleton, store, runtime, planner, providerLabel: "minimax" });
  // skeleton / research / validation 由本地完成，planner 不被调用；
  // itinerary / presentation / commercial 各调用 1 次。
  assert.equal(planner.calls.filter((c) => c.stage === "itinerary").length, 1);
  assert.equal(planner.calls.filter((c) => c.stage === "presentation").length, 1);
  assert.equal(planner.calls.filter((c) => c.stage === "commercial").length, 1);
  assert.ok(!planner.calls.some((c) => c.stage === "research"), "research 阶段是本地 deterministic，不调用 planner");
  assert.equal(planner.calls.length, 3, "总调用次数 = 3（不含 skeleton / research / validation）");
});

test("research tasks 由本地 deterministic 生成，标签不含「已确认 / 已解决」", async () => {
  const store = new InMemoryStore();
  const runtime = new FakeRuntime();
  const planner = new FakePlanner(buildFakeScript());
  const result = await runPlan({ projectId: "p4", skeleton, store, runtime, planner, providerLabel: "minimax" });
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
  await runPlan({ projectId: "p5", skeleton, store, runtime, planner, providerLabel: "minimax" });
  const firstCalls = planner.calls.length;
  // 第二次跑（模拟重启后 resume）：应当立即判定 completed，不调用 planner。
  const planner2 = new FakePlanner(buildFakeScript());
  const result2 = await runPlan({ projectId: "p5", skeleton, store, runtime, planner: planner2, providerLabel: "minimax" });
  assert.equal(result2.status, "completed");
  assert.equal(planner2.calls.length, 0, "resume 不应再调 planner");
  assert.equal(firstCalls, 3);
});

test("assistant 回复反映实际接受 / 缺失模块，不抄模型 reply", async () => {
  const store = new InMemoryStore();
  const runtime = new FakeRuntime();
  const planner = new FakePlanner(buildFakeScript());
  const result = await runPlan({ projectId: "p6", skeleton, store, runtime, planner, providerLabel: "minimax" });
  // 模型在 presentation 阶段写过「已生成 presentation」；orchestrator 的回复应当不抄。
  assert.ok(!result.assistantReply.includes("已生成 presentation"), `assistant reply 不应抄模型字符串：${result.assistantReply}`);
  assert.ok(result.assistantReply.includes("完成"));
});