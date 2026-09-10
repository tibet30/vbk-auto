import assert from "node:assert/strict";
import test from "node:test";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import { evaluatePreparationCompletion, preparationApprovalBlockReason } from "../../src/main/planning/preparation-completion.js";
import { computeReadiness } from "../../src/main/readiness.js";
import { agentCompletionGate, buildAgentApproval } from "../../src/main/agent/integration-gates.js";
import { AgentCore } from "../../src/main/agent/core.js";
import type { AgentCoreDependencies } from "../../src/main/agent/types.js";
import type { AgentSnapshot, ProductDetail, ProductReadiness } from "../../src/shared/contracts.js";

const readyReadiness = { ready: true, issues: [] } as unknown as ProductReadiness;

function completeDraft(): ProductDetail {
  const product = buildProductSnapshot({ destination: "成都", days: 2, productForm: "privateTour" });
  Object.assign(product.product.basicInfo!, {
    subtitle: "成都两日私家团",
    province: "四川",
    operationNotes: "按约定行程安排",
    userIdea: "D1 去宽窄巷子，D2 去武侯祠，包车",
  });
  Object.assign(product.product.operations!, {
    pickupCity: "成都",
    hotelTier: "当地5钻酒店/-38",
    transport: "charter",
    vehicleResource: { resourceGroupId: 88, resourceGroupName: "成都5座商务车" },
    trafficLine: { enabled: false, variants: [] },
    bookingControls: { butler: { contactCardId: 1, displayName: "管家A", providerId: 100 } },
  });
  product.product.presentation = {
    recommendation: "两日慢游成都",
    features: "专车接送与精选酒店",
    recommendations: [
      { category: "服务保障", text: "专车接送行程更省心" },
      { category: "精选酒店", text: "入住当地五钻酒店" },
      { category: "特色美食", text: "覆盖宽窄巷子小吃" },
    ],
    cover: { source: "ctripLibrary", imageId: 101001, imageUrl: "https://example.test/kuanzhai-cover.jpg", poi: "宽窄巷子", description: "宽窄巷子横版封面", minQuality: 3 },
  };
  product.product.itinerary = [
    { day: 1, title: "宽窄巷子", description: "游览宽窄巷子", hotel: "无", meals: "早餐自理；午餐自理；晚餐自理", spots: [{ name: "宽窄巷子", poiName: "宽窄巷子", poiId: 101 }] },
    { day: 2, title: "武侯祠", description: "游览武侯祠后返程", hotel: "无", meals: "早餐自理；午餐自理；晚餐自理", spots: [{ name: "武侯祠", poiName: "武侯祠", poiId: 102 }] },
  ];
  product.product.commercial = {
    packageName: "成都2天1晚私家团",
    pricing: { currency: "CNY", adult: 1880, child: 980, minimumTravelers: 1, cost: { adult: 1500, child: 700, singleSupplement: 0, childBed: 0 } },
    inventory: { startDate: "2026-09-01", endDate: "2027-09-01", dailyQuota: 30 },
    release: { submitReview: false, publishAfterApproval: false, publicPriceCeiling: 2500, publicAuditRetries: 3 },
  };
  product.researchTasks = [];
  return product;
}

test("缺套餐名、定价、班期时不允许批准", () => {
  const product = completeDraft();
  delete (product.product.commercial as Record<string, unknown>).packageName;
  delete (product.product.commercial as Record<string, unknown>).pricing;
  delete (product.product.commercial as Record<string, unknown>).inventory;

  const evaluation = evaluatePreparationCompletion(product);
  assert.equal(evaluation.ready, false);
  assert.equal(evaluation.currentStage, "completion");
  assert.ok(evaluation.missing.some((item) => item.includes("套餐名称")));
  assert.ok(evaluation.missing.some((item) => item.includes("定价")));
  assert.ok(evaluation.missing.some((item) => item.includes("班期") || item.includes("库存")));
  const legacy = computeReadiness({ product: product.product, researchTasks: product.researchTasks });
  assert.equal(legacy.ready, true);
  assert.equal(legacy.issues.some((issue) => /套餐|定价|库存|班期/.test(issue.label)), false);
  assert.ok(!evaluation.allowedActions.includes("request_approval"));
  assert.ok(evaluation.prohibitedActions.includes("request_approval"));
  assert.ok(evaluation.postApprovalDeterministic.some((item) => item.id === "commercial.terms"));
  assert.equal(typeof evaluation.itineraryInputMode, "string");

  const gate = agentCompletionGate(product, undefined, readyReadiness, { runId: "r", hadWrites: true, hadRemoteWrites: false });
  assert.equal(gate.verified, false);
  assert.equal(gate.finalApproval, undefined);
  assert.match(gate.message ?? "", /completion|套餐名称|定价/);
  assert.match(gate.message ?? "", /当前阶段/);
});

test("早期 request_approval 即使模型忽略 Prompt 也会失败并返回当前阶段和缺失项", async () => {
  const product = completeDraft();
  delete (product.product.commercial as Record<string, unknown>).packageName;
  const reason = preparationApprovalBlockReason(product);
  assert.match(reason ?? "", /本地方案尚未准备完成，不能进入 VBK 录入/);
  assert.match(reason ?? "", /completion\/commercial/);
  assert.match(reason ?? "", /套餐名称/);

  const saved = new Map<string, AgentSnapshot>();
  let modelCalls = 0;
  const deps: AgentCoreDependencies = {
    model: {
      complete: async () => {
        modelCalls += 1;
        if (modelCalls === 1) {
          return {
            toolCalls: [{ id: "approval", name: "request_approval", arguments: { scope: ["vbk.write_phase:basic"], summary: "录入" } }],
          };
        }
        return { content: "done" };
      },
    },
    tools: [],
    accountFor: async () => ({ accountKey: "account", productVersion: "version" }),
    approvalPrecondition: async () => preparationApprovalBlockReason(product),
    id: (() => { let n = 0; return () => `id-${++n}`; })(),
    now: () => new Date("2026-09-09T00:00:00.000Z"),
  };
  const core = new AgentCore(deps, {
    getAgentSnapshot: (id) => saved.get(id),
    saveAgentSnapshot: (value) => { saved.set(value.localProductId, structuredClone(value)); },
  });
  await core.send("early-approval", "可以录入了");
  await core.idle("early-approval");
  const snapshot = await core.get("early-approval");
  assert.equal(snapshot.pendingApproval, undefined);
  const result = snapshot.events.find((event) => event.type === "tool_result");
  assert.match(result?.content ?? "", /当前不能审批/);
  assert.match(result?.content ?? "", /当前阶段 completion\/commercial/);
  assert.match(result?.content ?? "", /套餐名称/);
});

test("完成阶段三后只允许一次批准", () => {
  const product = completeDraft();
  const first = evaluatePreparationCompletion(product);
  assert.equal(first.ready, true);
  assert.equal(first.currentStage, "completion");
  assert.equal(first.currentNode, "finalValidation");
  assert.deepEqual(first.missing, []);
  assert.ok(first.allowedActions.includes("request_approval"));
  assert.ok(!first.prohibitedActions.includes("request_approval"));

  const snapshot: AgentSnapshot = {
    localProductId: product.id,
    run: { id: "r", status: "waiting_approval", createdAt: "t", updatedAt: "t", intentVersion: "intent" },
    pendingApproval: {
      id: "a1", productVersion: "v", accountKey: "account", intentVersion: "intent",
      scope: ["vbk.write_phase:basic"], summary: "最终确认", status: "pending", createdAt: "t",
    },
    events: [],
  };
  const second = evaluatePreparationCompletion(product, snapshot);
  assert.equal(second.ready, true);
  assert.ok(!second.allowedActions.includes("request_approval"));
  assert.ok(second.prohibitedActions.includes("request_approval"));

  const gate = agentCompletionGate(product, snapshot, readyReadiness, { runId: "r", hadWrites: true, hadRemoteWrites: false });
  assert.equal(gate.verified, false);
  assert.ok(gate.finalApproval);
  assert.deepEqual(gate.finalApproval?.scope, buildAgentApproval(product).scope);
});

test("未启用大交通不会被错误阻塞，启用后缺可用性核验会阻塞", () => {
  const disabled = completeDraft();
  const disabledEval = evaluatePreparationCompletion(disabled);
  assert.equal(disabledEval.ready, true);
  assert.ok(!disabledEval.missing.some((item) => item.includes("大交通")));

  const enabled = completeDraft();
  (enabled.product.operations as Record<string, unknown>).trafficLine = {
    enabled: true,
    variants: ["flightRoundTrip"],
  };
  const enabledEval = evaluatePreparationCompletion(enabled);
  assert.equal(enabledEval.ready, false);
  assert.ok(enabledEval.missing.some((item) => item.includes("大交通") && item.includes("可用性")));
  assert.ok(enabledEval.allowedActions.includes("recheck_traffic_line_availability"));
  assert.ok(!enabledEval.allowedActions.includes("request_approval"));

  const verified = completeDraft();
  (verified.product.operations as Record<string, unknown>).trafficLine = {
    enabled: true,
    variants: ["flightRoundTrip"],
    availability: {
      endpointPlan: {
        arrivalCity: "成都",
        departureCity: "成都",
        resolvedAt: "2026-09-09T00:00:00.000Z",
        flight: { arrival: { code: "CTU", name: "成都双流国际机场" }, departure: { code: "CTU", name: "成都双流国际机场" } },
      },
      availableVariants: ["flightRoundTrip"],
      unavailableVariants: {},
    },
  };
  assert.equal(evaluatePreparationCompletion(verified).ready, true);
});

test("住宿日缺酒店候选才阻塞，无住宿日不要求酒店候选", () => {
  const lodging = completeDraft();
  (lodging.product.itinerary as Array<Record<string, unknown>>)[0]!.hotel = "成都酒店";
  const blocked = evaluatePreparationCompletion(lodging);
  assert.equal(blocked.ready, false);
  assert.ok(blocked.missing.some((item) => item.includes("酒店候选")));
  const legacy = computeReadiness({ product: lodging.product, researchTasks: lodging.researchTasks });
  assert.equal(legacy.ready, true);
  assert.equal(legacy.issues.some((issue) => issue.label.includes("酒店候选")), false);

  const noStay = completeDraft();
  assert.equal(evaluatePreparationCompletion(noStay).ready, true);
});

test("跟团游不要求用车资源组，私家团缺资源组会阻塞", () => {
  const group = completeDraft();
  (group.product.sales as Record<string, unknown>).productForm = "groupTour";
  (group.product.sales as Record<string, unknown>).guideIncluded = true;
  delete (group.product.operations as Record<string, unknown>).vehicleResource;
  assert.equal(evaluatePreparationCompletion(group).ready, true);

  const privateTour = completeDraft();
  delete (privateTour.product.operations as Record<string, unknown>).vehicleResource;
  const blocked = evaluatePreparationCompletion(privateTour);
  assert.equal(blocked.ready, false);
  assert.ok(blocked.missing.some((item) => item.includes("用车")));
});

test("缺天数时停在 foundation，不允许 request_approval", () => {
  const product = completeDraft();
  (product.product.basicInfo as Record<string, unknown>).days = 0;
  const evaluation = evaluatePreparationCompletion(product);
  assert.equal(evaluation.ready, false);
  assert.equal(evaluation.currentStage, "foundation");
  assert.equal(evaluation.currentNode, "skeleton");
  assert.ok(evaluation.missing.some((item) => item.includes("出行天数") || item.includes("days")));
  assert.ok(!evaluation.allowedActions.includes("request_approval"));
  assert.ok(evaluation.prohibitedActions.includes("request_approval"));
});

test("缺封面时停在 completion/cover，并开放 resolve_cover", () => {
  const product = completeDraft();
  delete (product.product.presentation as Record<string, unknown>).cover;
  const evaluation = evaluatePreparationCompletion(product);
  assert.equal(evaluation.ready, false);
  assert.equal(evaluation.currentStage, "completion");
  assert.equal(evaluation.currentNode, "cover");
  assert.ok(evaluation.missing.some((item) => item.includes("封面")));
  assert.ok(evaluation.allowedActions.includes("resolve_cover"));
  assert.ok(!evaluation.allowedActions.includes("request_approval"));
});

test("evaluator 从 product.messages 锁定最新纠正后的行程", () => {
  const product = completeDraft();
  product.messages = [
    ...product.messages,
    { id: "fix", role: "user", content: "第二天改成锦里", createdAt: "2026-09-09T00:00:00.000Z" },
  ];
  const evaluation = evaluatePreparationCompletion(product);
  assert.deepEqual(evaluation.lockedConstraints.itineraryOrder, [
    { day: 1, spots: ["宽窄巷子"] },
    { day: 2, spots: ["锦里"] },
  ]);
  assert.equal(evaluation.itineraryInputMode, "complete");
  assert.ok(!evaluation.lockedConstraints.pois.includes("武侯祠"));
});

test("未完成的 POI 研究任务会阻塞批准", () => {
  const product = completeDraft();
  product.researchTasks = [{
    id: "task-1",
    label: "宽窄巷子",
    type: "vbk",
    status: "running",
    state: "needs_confirmation",
    detail: "POI 未匹配，待人工确认",
  }];
  (product.product.itinerary as Array<Record<string, unknown>>)[0]!.spots = [{ name: "宽窄巷子", poiName: null, poiId: null }];
  const evaluation = evaluatePreparationCompletion(product);
  assert.equal(evaluation.ready, false);
  assert.equal(evaluation.currentStage, "itinerary");
  assert.ok(!evaluation.allowedActions.includes("request_approval"));
});
