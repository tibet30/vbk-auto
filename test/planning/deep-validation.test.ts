/**
 * Deep validation 测试：
 *  - itinerary 长度 = skeleton.days，days 是顺序递增且唯一；
 *  - presentation 必须恰好 3 条互不重复且 category 在白名单的 recommendations；
 *  - commercial 子字段（pricing/inventory/release/terms）格式不合法时被标记为 rejected；
 *  - persistence 是「truth」：validation 阶段从持久化产品反推，不依赖内存 accumulator。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { runPlan } from "../../src/main/planning/plan-orchestrator.js";
import { deepValidateModules } from "../../src/main/planning/validation.js";
import { detectAcceptedModulesFromProduct } from "../../src/main/planning/runtime.js";
import type {
  GenerationStateStore, OrchestratorRuntime,
} from "../../src/main/planning/types.js";
import type {
  Planner, PlannerRequest, PlanningStageOutput, PlanningGenerationState, PlanningModule, ResearchTaskProposal,
} from "../../src/shared/contracts-planning.js";
import { AI_WRITABLE_PATHS } from "../../src/main/planning/schemas.js";

class AllStagesOkPlanner implements Planner {
  async generateStage(request: PlannerRequest): Promise<PlanningStageOutput> {
    if (request.stage === "itinerary") {
      return {
        reply: "itin", modules: [{ module: "itinerary", status: "accepted", value: [
          { day: 1, title: "D1", spots: ["A"], description: "D", hotel: "H", meals: "B/L/D" },
          { day: 2, title: "D2", spots: ["B"], description: "D", hotel: "", meals: "B/L/D" },
        ] }],
      };
    }
    if (request.stage === "presentation") {
      return {
        reply: "pres", modules: [{ module: "presentation", status: "accepted", value: {
          recommendationCategory: "优选行程", recommendation: "R",
          recommendations: [
            { category: "优选行程", text: "a" }, { category: "精选酒店", text: "b" }, { category: "缤纷景点", text: "c" },
          ],
          features: "f",
        } }],
      };
    }
    if (request.stage === "commercial") {
      return {
        reply: "com", modules: [
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
  product: Record<string, unknown> = {};
  async loadExistingResearchTasks() { return []; }
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
  async addResearchTask() { return "id"; }
  async loadHistory() { return []; }
  async loadCurrentProduct() { return this.product; }
  async loadAcceptedModules() { return detectAcceptedModulesFromProduct(this.product); }
}

const skeleton = { destination: "太原", days: 2, nights: 1, productForm: "privateTour" as const, productType: "domesticShort" as const, supplierProductCode: "NEW" };

test("itinerary 长度必须等于 skeleton.days", () => {
  const product = {
    itinerary: [
      { day: 1, title: "D1", spots: ["A"], description: "D", meals: "M" },
    ],
  };
  const out = deepValidateModules({
    skeleton,
    product,
    acceptedModules: ["itinerary"],
  });
  assert.ok(out.invalid.some((m) => m.module === "itinerary"));
  assert.ok(/天数 1 ≠ 骨架天数 2/.test(out.invalid.find((m) => m.module === "itinerary")?.reason ?? ""));
});

test("itinerary days 必须顺序递增且唯一", () => {
  const product = {
    itinerary: [
      { day: 1, title: "D1", spots: ["A"], description: "D", meals: "M" },
      { day: 3, title: "D3", spots: ["B"], description: "D", meals: "M" },
    ],
  };
  const out = deepValidateModules({
    skeleton,
    product,
    acceptedModules: ["itinerary"],
  });
  const reason = out.invalid.find((m) => m.module === "itinerary")?.reason ?? "";
  assert.ok(/不是顺序递增/.test(reason), `应当报告 day 不是顺序递增：${reason}`);
});

test("presentation 必须是 3 条互不重复 + category 在白名单的 recommendations", () => {
  const product = {
    presentation: {
      recommendationCategory: "优选行程",
      recommendation: "R",
      recommendations: [
        { category: "优选行程", text: "a" }, { category: "优选行程", text: "b" }, { category: "缤纷景点", text: "c" },
      ],
      features: "f",
    },
  };
  const out = deepValidateModules({
    skeleton,
    product,
    acceptedModules: ["presentation"],
  });
  assert.ok(out.invalid.some((m) => m.module === "presentation"));
});

test("commercial.release.submitReview=true 不再被 deep validation 拒绝（历史 / 人工标记保留）", () => {
  // release.submitReview / publishAfterApproval 是人工 / VBK 发布的二段门；
  // deep validation 不再把它们当成 invalid 字段。只有 release.publicPriceCeiling
  // 缺失 / 不合法才仍被识别为 invalid。这是与 historical-data-non-copy / safe-release
  // 测试套协同的语义：AI 路径只能写 false，DB 路径默认保留 true。
  const product = {
    commercial: {
      packageName: "pkg",
      pricing: { currency: "CNY", adult: 1000, child: 500, minimumTravelers: 2 },
      inventory: { startDate: "2026-08-10", endDate: "2026-12-31", dailyQuota: 6 },
      terms: { inclusions: "i", exclusions: "e", bookingNotes: "b", refundPolicy: "r" },
      release: { submitReview: true, publishAfterApproval: false, publicPriceCeiling: 3000, publicAuditRetries: 4 },
    },
  };
  const out = deepValidateModules({
    skeleton,
    product,
    acceptedModules: ["packageName", "pricing", "inventory", "terms", "release"],
  });
  assert.equal(out.invalid.find((m) => m.module === "release"), undefined, "release 不应因 submitReview=true 被拒绝");
});

test("commercial.release.publicPriceCeiling 缺失时仍被 deep validation 拒绝", () => {
  // 反向断言：release 结构合法但必填数字字段丢失仍要触发 invalid，保证 AI
  // 遗漏 publicPriceCeiling 时不能靠 submitReview=true 躲过 deep validation。
  const product = {
    commercial: {
      release: { submitReview: true, publishAfterApproval: true },
    },
  };
  const out = deepValidateModules({
    skeleton,
    product,
    acceptedModules: ["release"],
  });
  const releaseReason = out.invalid.find((m) => m.module === "release")?.reason ?? "";
  assert.ok(/publicPriceCeiling/.test(releaseReason), `应当报告 publicPriceCeiling 缺失：${releaseReason}`);
});

test("完整 staged plan：persisted product 通过 deep validation", async () => {
  const store = new InMemoryStore();
  const rt = new FakeRuntime();
  const planner = new AllStagesOkPlanner();
  const result = await runPlan({ projectId: "p", skeleton, store, runtime: rt, planner, providerLabel: "minimax" });
  assert.equal(result.status, "completed");
  assert.equal(result.rejected.length, 0, "完整 plan 不应当被 deep validation 拒绝");
});
