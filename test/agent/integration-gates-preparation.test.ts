import assert from "node:assert/strict";
import test from "node:test";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import { agentCompletionGate } from "../../src/main/agent/integration-gates.js";
import { agentProductContext, agentTaskContext } from "../../src/main/agent/integration-context.js";
import { evaluatePreparationCompletion } from "../../src/main/planning/preparation-completion.js";
import { computeReadiness } from "../../src/main/readiness.js";
import type { AgentSnapshot, ProductReadiness } from "../../src/shared/contracts.js";

const ready = { ready: true, issues: [] } as unknown as ProductReadiness;

function product() {
  const p = buildProductSnapshot({ destination: "成都", days: 2, productForm: "privateTour" });
  Object.assign(p.product.basicInfo!, { subtitle: "成都旅行", province: "四川", operationNotes: "按约定行程安排" });
  Object.assign(p.product.operations!, { pickupCity: "成都" });
  Object.assign(p.product.commercial!, { packageName: "标准套餐" });
  p.product.itinerary = [1, 2].map((day) => ({ day, title: "游览成都", spots: [], description: "游览", hotel: "", meals: "" }));
  return p;
}

function fillLocalPreparation(target: ReturnType<typeof product>) {
  Object.assign(target.product.operations!, {
    hotelTier: "当地5钻酒店/-38",
    transport: "charter",
    vehicleResource: { resourceGroupId: 88, resourceGroupName: "成都5座商务车" },
    trafficLine: { enabled: false, variants: [] },
    bookingControls: { butler: { contactCardId: 1, displayName: "管家A", providerId: 100 } },
  });
  target.product.presentation = {
    recommendation: "两日慢游成都",
    features: "专车接送与精选酒店",
    recommendations: [
      { category: "服务保障", text: "专车接送行程更省心" },
      { category: "精选酒店", text: "入住当地五钻酒店" },
      { category: "特色美食", text: "覆盖宽窄巷子小吃" },
    ],
    cover: {
      source: "ctripLibrary",
      poi: "宽窄巷子",
      poiId: 101,
      poiName: "宽窄巷子",
      imageId: 8800101,
      imageUrl: "https://dimg.example.com/kuanzhai.jpg",
      description: "宽窄巷子横版封面",
      minQuality: 3,
    },
  };
  target.product.itinerary = [
    { day: 1, title: "宽窄巷子", description: "游览宽窄巷子", hotel: "无", meals: "早餐自理；午餐自理；晚餐自理", spots: [{ name: "宽窄巷子", poiName: "宽窄巷子", poiId: 101 }] },
    { day: 2, title: "武侯祠", description: "游览武侯祠后返程", hotel: "无", meals: "早餐自理；午餐自理；晚餐自理", spots: [{ name: "武侯祠", poiName: "武侯祠", poiId: 102 }] },
  ];
  Object.assign(target.product.commercial!, {
    packageName: "成都2天1晚私家团",
    pricing: { currency: "CNY", adult: 1880, child: 980, minimumTravelers: 1, cost: { adult: 1500, child: 700, singleSupplement: 0, childBed: 0 } },
    inventory: { startDate: "2026-09-01", endDate: "2027-09-01", dailyQuota: 30 },
    release: { submitReview: false, publishAfterApproval: false, publicPriceCeiling: 2500, publicAuditRetries: 3 },
  });
  target.researchTasks = [];
}

test("local planning requires final approval while stale saved draft cannot establish current completion", () => {
  const p = product();
  fillLocalPreparation(p);
  p.productId = "123";
  p.status = "draft_saved";
  const snapshot: AgentSnapshot = {
    localProductId: p.id,
    run: { id: "r", status: "running", intentVersion: "intent", createdAt: "2026-09-05", updatedAt: "2026-09-05" },
    events: [],
  };
  const result = agentCompletionGate(p, snapshot, ready, { runId: "r", hadWrites: true, hadRemoteWrites: false });
  assert.ok(result.finalApproval);
  assert.equal(result.verified, false);
  assert.equal(agentCompletionGate(p, snapshot, ready, { runId: "r", hadWrites: true, hadRemoteWrites: true }).verified, false);
});

test("agent context keeps unmatched POIs for manual review and hands off after final confirmation", async () => {
  const context = agentTaskContext({ getProduct: () => product() } as any, "product-1");
  const parsed = JSON.parse(context) as { rules?: string[] };
  const rules = parsed.rules ?? [];
  assert.ok(rules.some((rule) => rule.includes("禁止覆盖或改换成其他地点")));
  assert.ok(rules.some((rule) => rule.includes("只有原始需求缺少且无法可靠推导")));
  assert.ok(rules.some((rule) => rule.includes("系统按已授权范围自动确定性录入与回读")));
  assert.equal(rules.some((rule) => rule.includes("execute_vbk_phase")), false);
  assert.equal(rules.some((rule) => rule.includes("自动检索同城、同主题、可游览的单一替代 POI")), false);
  assert.doesNotMatch(context, /execute_vbk_phase/);
});

test("read_product exposes exact approval scope and actionable readiness without nesting old dialogue", () => {
  const p = product();
  delete (p.product.commercial as Record<string, unknown>).packageName;
  p.messages = [{ id: "old", role: "assistant", content: "OLD_DIALOGUE".repeat(10000) }] as any;
  const context = agentProductContext(p);
  assert.ok(!context.readiness.issues.some((issue) => issue.label === "commercial.packageName"));
  assert.deepEqual(context.requiredApprovalScope, context.requiredPhases.map((phase) => `vbk.write_phase:${phase}`));
  assert.ok(!JSON.stringify(context).includes("OLD_DIALOGUE"));
});

test("确认卡可见就绪度消费权威 evaluator，不再出现旧 readiness 100%", () => {
  const p = buildProductSnapshot({ destination: "太原", days: 1, productForm: "groupTour" });
  Object.assign(p.product.basicInfo!, {
    subtitle: "太原经典行程", province: "山西", operationNotes: "无",
  });
  Object.assign(p.product.operations!, {
    hotelSource: "nonPlatform", hotelTier: "当地3钻酒店/-3", mealsIncluded: false,
    pickupCity: "太原", transport: "charter", reusePickupForDropoff: true,
    bookingControls: { butler: { contactCardId: 1, displayName: "管家A", providerId: 100 } },
  });
  p.product.presentation = {
    recommendation: "推荐", features: "特色",
    recommendations: [
      { category: "优选行程", text: "节奏舒适不赶路" },
      { category: "精选酒店", text: "当地 3 钻酒店含早餐" },
      { category: "缤纷景点", text: "覆盖晋祠与博物院" },
    ],
    cover: {
      source: "ctripLibrary",
      poi: "晋祠博物馆",
      poiId: 79413,
      poiName: "晋祠博物馆",
      imageId: 88079413,
      imageUrl: "https://dimg.example.com/jinci.jpg",
      description: "横版晋祠外景",
      minQuality: 3,
    },
  };
  p.product.itinerary = [{
    day: 1, title: "晋祠", spots: [{ name: "晋祠博物馆", poiName: "晋祠博物馆", poiId: 79413 }],
    description: "专车接站游览晋祠。", hotel: "无", meals: "早餐自理；午餐自理；晚餐自理",
  }];
  p.product.commercial = {};
  p.product.sales = { productType: "domesticShort", productForm: "groupTour", splitGroup: false, guideIncluded: true };
  p.researchTasks = [];

  const legacy = computeReadiness({ product: p.product, researchTasks: p.researchTasks });
  const evaluation = evaluatePreparationCompletion(p);
  const visible = agentProductContext(p);
  assert.equal(legacy.ready, true);
  assert.equal(evaluation.ready, false);
  assert.equal(visible.readiness.ready, false);
  assert.equal(visible.readiness.ready, evaluation.ready);
  assert.ok(visible.readiness.issues.some((issue) => issue.label.includes("套餐") || issue.label.includes("定价") || issue.label.includes("库存")));
  assert.ok(evaluation.postApprovalDeterministic.some((item) => item.id === "commercial.terms"));
  assert.deepEqual(visible.preparation.postApprovalDeterministic, evaluation.postApprovalDeterministic);
});
