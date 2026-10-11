import assert from "node:assert/strict";
import test from "node:test";
import type { PreparationEvaluation, PreparationGap } from "../../src/shared/contracts-preparation.js";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import { evaluatePreparationCompletion } from "../../src/main/planning/preparation-completion.js";
import { denyPreparationTool } from "../../src/main/agent/preparation-action-guard.js";
import { decidePreparationAction } from "../../src/main/agent/preparation-director.js";
import {
  preparationActions,
  preparationActionPlan,
  preparationGenerationAllowed,
  preparationPosition,
  preparationStageGaps,
} from "../../src/main/planning/preparation/policy.js";

function gap(code: PreparationGap["code"], node: PreparationGap["node"], stage: PreparationGap["stage"] = "completion"): PreparationGap {
  return { code, node, stage, label: "可修改的界面文案", detail: "可修改的说明" };
}

function evaluation(gaps: PreparationGap[], ready = false): PreparationEvaluation {
  const position = preparationPosition(gaps);
  const actions = preparationActions({ stage: position.stage, gaps, ready, hasApproval: false, coverSearchExhausted: false });
  return {
    promptVersion: "test", ready, currentStage: position.stage, currentNode: position.node,
    gaps, missing: gaps.map((item) => item.label), blockingReasons: gaps.map((item) => item.detail),
    allowedActions: actions.allowed, prohibitedActions: actions.prohibited,
    completionCriteria: [], lockedConstraints: { pois: [], itineraryOrder: [] },
    itineraryInputMode: "open", postApprovalDeterministic: [],
  };
}

test("stage order and resource permissions use classified gaps, independent of display wording", () => {
  const gaps = [gap("traffic", "finalValidation"), gap("hotel", "hotelResolution"), gap("foundation", "skeleton", "foundation")];
  assert.deepEqual(preparationPosition(gaps), { stage: "foundation", node: "skeleton" });
  assert.deepEqual(preparationStageGaps(evaluation(gaps)), [gaps[2]]);
  const completion = evaluation(gaps.slice(0, 2));
  assert.ok(completion.allowedActions.includes("resolve_itinerary_hotels"));
  assert.ok(completion.allowedActions.includes("recheck_traffic_line_availability"));
  assert.deepEqual(preparationActionPlan(completion), { node: "hotelResolution", name: "resolve_itinerary_hotels", arguments: {} });
  assert.ok(!completion.allowedActions.includes("request_approval"));
});

test("generation cannot skip itinerary work or replace a commercial gap with unrelated copy", () => {
  const itinerary = evaluation([gap("itinerary", "itineraryDraft", "itinerary"), gap("commercial", "commercial")]);
  assert.equal(preparationGenerationAllowed(itinerary, "itinerary"), true);
  assert.equal(preparationGenerationAllowed(itinerary, "commercial"), false);
  const commercial = evaluation([gap("commercial", "commercial")]);
  assert.equal(preparationGenerationAllowed(commercial, "commercial"), true);
  assert.equal(preparationGenerationAllowed(commercial, "presentation"), false);
  assert.equal(preparationGenerationAllowed(evaluation([], true), "commercial"), false);
  assert.equal(preparationActionPlan(evaluation([], true)), undefined);
});

test("copy gaps allow their own basicInfo generator without reopening foundation", () => {
  const value = evaluation([gap("copy", "copy")]);
  assert.equal(value.currentStage, "completion");
  assert.equal(preparationGenerationAllowed(value, "basicInfo"), true);
  assert.equal(preparationGenerationAllowed(value, "skeleton"), false);
});

test("approval and exhausted cover fallback remain bounded by readiness", () => {
  const blocked = preparationActions({ stage: "completion", gaps: [gap("cover", "cover")], ready: false, hasApproval: false, coverSearchExhausted: true });
  assert.ok(!blocked.allowed.includes("resolve_cover"));
  assert.ok(!blocked.allowed.includes("request_approval"));
  const approved = preparationActions({ stage: "completion", gaps: [], ready: true, hasApproval: true, coverSearchExhausted: false });
  assert.deepEqual(approved.allowed, ["read_product", "ask_user", "patch_product"]);
  assert.ok(approved.prohibited.includes("request_approval"));
});

test("persisted reload preserves next action and retry fingerprint without changing locked fields", () => {
  const product = buildProductSnapshot({ destination: "潮州", days: 2, productForm: "privateTour" });
  Object.assign(product.product.basicInfo!, { province: "广东", subtitle: "潮州两日私家团", operationNotes: "保留原日程" });
  Object.assign(product.product.operations!, { pickupCity: "潮州", transport: "charter" });
  product.product.basicInfo!.userIdea = "1-广济桥---牌坊街\n2-南澳大桥---海岸游览";
  const before = structuredClone(product);
  const first = decidePreparationAction(product);
  const restored = JSON.parse(JSON.stringify(product));
  assert.deepEqual(decidePreparationAction(restored), first);
  assert.equal(evaluatePreparationCompletion(restored).currentNode, "itineraryDraft");
  assert.ok(denyPreparationTool(restored, undefined, "generate_product_module", { stage: "commercial" }));
  assert.equal(denyPreparationTool(restored, undefined, "generate_product_module", { stage: "itinerary" }), undefined);
  assert.deepEqual(product, before);
  assert.equal(product.product.basicInfo!.meetingCity, "潮州");
  assert.equal(product.product.basicInfo!.destinationCity, "潮州");
});
