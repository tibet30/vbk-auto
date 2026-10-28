import assert from "node:assert/strict";
import test from "node:test";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import { evaluatePreparationCompletion, isCoverHandoffReady, preparationApprovalBlockReason } from "../../src/main/planning/preparation-completion.js";
import { computeReadiness } from "../../src/main/readiness.js";
import { productSchema } from "../../src/main/automation/schema/schema-definitions.js";
import { agentCompletionGate, agentProductVersion, buildAgentApproval } from "../../src/main/agent/integration-gates.js";
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
      { category: "服务保障", text: "全程专车衔接酒店与宽窄巷子，避开自行换乘的繁琐，2天出行更安心" },
      { category: "精选酒店", text: "1晚当地高品质住宿，位置与卫生双重把关，整体休息体验更舒适安心" },
      { category: "特色美食", text: "沿途安排宽窄巷子与本地老店特色小吃，餐食与景点结合，体验更丰富" },
    ],
    cover: { source: "ctripLibrary", imageId: 101001, imageUrl: "https://example.test/kuanzhai-cover.jpg", alternates: [{ imageId: 101002, imageUrl: "https://example.test/wuhou.jpg", poi: "武侯祠", poiId: 102 }], poi: "宽窄巷子", description: "宽窄巷子横版封面", minQuality: 3,
      alternates: [{ imageId: 101002, imageUrl: "https://example.test/wuhou.jpg", poi: "武侯祠" }] },
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

test("付费景点缺图不阻止确认；补图可选且缺图清单不成为卡点", () => {
  const product = completeDraft();
  const cover = product.product.presentation!.cover as any;
  delete cover.alternates;
  delete cover.missingPoiImages;
  for (const missingPoiImages of [undefined, ["武侯祠"]]) {
    cover.missingPoiImages = missingPoiImages;
    const result = evaluatePreparationCompletion(product);
    assert.equal(result.ready, true, JSON.stringify(result.missing));
    assert.ok(result.allowedActions.includes("request_approval"));
    assert.ok(result.allowedActions.includes("resolve_cover"));
    assert.ok(!result.missing.some(item => /配图|景点图片/.test(item)));
    assert.equal(preparationApprovalBlockReason(product), undefined);
  }
});
