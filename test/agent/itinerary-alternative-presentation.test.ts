import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentCore } from "../../src/main/agent/core.js";
import { agentPlannerContext } from "../../src/main/agent/integration-context.js";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import { evaluatePreparationCompletion, preparationApprovalBlockReason } from "../../src/main/planning/preparation-completion.js";
import { composePlanningUserMessage } from "../../src/main/planning/adapters/planning-prompt.js";
import { repairExcludedAlternativeCopy } from "../../src/main/planning/itinerary-alternative-copy.js";
import { alternativeGroupKey } from "../../src/shared/trusted-operator-itinerary-removals.js";
import type { ProductDetail } from "../../src/shared/contracts.js";

const RECOMMENDATIONS = [
  { category: "服务保障", text: "全程专车衔接核心景点与住宿，减少换乘等待，按每日节奏安排游览更从容安心。" },
  { category: "精选酒店", text: "优先安排日喀则当地舒适住宿，结合每日路线合理衔接，让休息与游览节奏更自然。" },
  { category: "特色美食", text: "围绕日喀则博物馆和扎什伦布寺安排游览体验，保留充足时间感受当地文化脉络。" },
];

function staleProduct(): ProductDetail {
  const product = buildProductSnapshot({ destination: "日喀则", days: 3, productForm: "privateTour", userIdea: "第3天 日喀则博物馆 或 非物质文化遗产中心参观。" });
  Object.assign(product.product.basicInfo!, { province: "西藏", subtitle: "日喀则三日私家团", operationNotes: "按用户原定顺序安排" });
  Object.assign(product.product.operations!, { pickupCity: "日喀则", transport: "charter", hotelTier: "当地5钻酒店/-38", trafficLine: { enabled: false, variants: [] } });
  product.product.itinerary = [
    { day: 1, title: "萨迦古城", description: "游览萨迦古城。", hotel: "无", meals: "自理", spots: [{ name: "萨迦古城", poiName: "萨迦古城", poiId: 101 }] },
    { day: 2, title: "羊卓雍湖", description: "游览羊卓雍湖。", hotel: "无", meals: "自理", spots: [{ name: "羊卓雍湖", poiName: "羊卓雍湖", poiId: 102 }] },
    { day: 3, title: "日喀则博物馆与非物质文化遗产中心参观", description: "上午安排日喀则博物馆或非物质文化遗产中心参观，随后游览扎什伦布寺。", hotel: "无", meals: "自理", spots: [
      { name: "日喀则博物馆", poiName: "日喀则博物馆", poiId: 103, relation: "or", timeOfDay: "morning" },
      { name: "扎什伦布寺", poiName: "扎什伦布寺", poiId: 104, relation: "and", timeOfDay: "afternoon" },
    ] },
  ];
  product.product.presentation = {
    recommendationCategory: "优选行程",
    recommendation: "日喀则博物馆与非遗参观的三日私家体验。",
    features: "<p>第三天上午安排日喀则博物馆与非遗参观。</p>",
    recommendations: RECOMMENDATIONS,
  };
  return product;
}

function cleanPresentation() {
  return {
    recommendationCategory: "优选行程",
    recommendation: "围绕日喀则博物馆与扎什伦布寺安排三日私家体验。",
    features: "<p>第三天上午安排日喀则博物馆，随后游览扎什伦布寺。</p>",
    recommendations: RECOMMENDATIONS,
  };
}

test("C05 无可信删除凭证时保留 OR 文案，并因缺失明确景点阻断 readiness", () => {
  const product = staleProduct();
  const original = structuredClone(product.product.itinerary);
  const repaired = repairExcludedAlternativeCopy(product, product.product.itinerary);
  const evaluation = evaluatePreparationCompletion(product);
  assert.equal(repaired.changed, false);
  assert.deepEqual(repaired.itinerary, original);
  assert.match(`${product.product.itinerary![2]!.title} ${product.product.itinerary![2]!.description}`, /非物质文化遗产中心/);
  assert.equal(evaluation.ready, false);
  assert.equal(evaluation.missing.includes("每日行程"), true);
  assert.match(evaluation.blockingReasons.join("\n"), /二选一景点必须全部保留/);
});

test("C06 缺失明确 OR 槽位时提示原始行程，酒店同名不触发删除", () => {
  const product = staleProduct();
  const context = agentPlannerContext(product, "test", "model");
  const prompt = composePlanningUserMessage({ stage: "presentation", context });
  assert.match(prompt, /当前产品草稿/);
  assert.match(prompt, /"itinerary"/);
  assert.match(prompt, /非物质文化遗产中心参观/);
  product.product.itinerary = repairExcludedAlternativeCopy(product, product.product.itinerary).itinerary;
  product.product.presentation = { ...cleanPresentation(), features: "<p>两晚住非遗中心酒店，第三天游览日喀则博物馆。</p>" };
  const evaluation = evaluatePreparationCompletion(product);
  assert.equal(evaluation.missing.includes("每日行程"), true);
  assert.equal(evaluation.missing.includes("派生行程文案"), false);
  assert.match(String((product.product.presentation as Record<string, unknown>).features), /非遗中心酒店/);
});

test("C07 未核验 OR 仍阻断，普通非 OR 文案不作为派生文案缺口", () => {
  const product = staleProduct();
  const day3 = product.product.itinerary![2]!;
  day3.spots[0] = { name: "日喀则博物馆", poiName: null, poiId: null, relation: "or" };
  const unresolved = evaluatePreparationCompletion(product);
  assert.equal(unresolved.missing.includes("每日行程"), true);
  assert.match(unresolved.blockingReasons.join("\n"), /二选一景点必须全部保留/);

  const ordinary = staleProduct();
  ordinary.product.basicInfo!.userIdea = "第3天游览日喀则博物馆和扎什伦布寺。";
  assert.equal(evaluatePreparationCompletion(ordinary).missing.includes("派生行程文案"), false);

  const operatorRemoved = staleProduct();
  const names = ["日喀则博物馆", "非物质文化遗产中心参观"];
  operatorRemoved.product.manualReview = { itinerarySpotRemovals: [{
    day: 3, name: "非物质文化遗产中心参观", removedAt: "2026-10-04T00:00:00.000Z", groupKey: alternativeGroupKey(3, names),
  }] };
  const repaired = repairExcludedAlternativeCopy(operatorRemoved, operatorRemoved.product.itinerary);
  assert.equal(repaired.changed, true, "只有可信且绑定原 OR 组的删除凭证允许清理旧日文案");
  assert.doesNotMatch(`${repaired.itinerary[2]!.title} ${repaired.itinerary[2]!.description}`, /非物质文化遗产中心|非遗中心/);
});

test("C06 缺失明确 OR 槽位时，即使模型请求确认也不会创建审批卡", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "vbk-or-approval-"));
  const db = new VbkDatabase(root);
  try {
    const product = staleProduct();
    product.product.presentation = cleanPresentation();
    db.importProductSnapshot(product);
    const modelResults = [
      { toolCalls: [{ id: "stale", name: "request_approval", arguments: { scope: ["vbk.write_phase:basic"], summary: "第三天博物馆/非遗中心二选一，确认后录入。" } }] },
      { content: "缺失景点需要先完成本地核验。" },
    ];
    const core = new AgentCore({
      model: { complete: async () => modelResults.shift() ?? { content: "已修正。" } },
      tools: [],
      accountFor: async () => ({ accountKey: "local", productVersion: "v1" }),
      preparationProduct: (id) => db.getProduct(id),
      approvalPrecondition: async (id) => preparationApprovalBlockReason(db.getProduct(id)!),
    }, db);
    await core.send(product.id, "请发起最终确认");
    await core.idle(product.id);
    const snapshot = await core.get(product.id);
    assert.equal(snapshot.pendingApproval, undefined);
    assert.match(snapshot.events.map((event) => event.content).join("\n"), /二选一景点必须全部保留|本地方案尚未准备完成/);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
