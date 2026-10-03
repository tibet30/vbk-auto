import assert from "node:assert/strict";
import test from "node:test";
import { agentCompletionGate } from "../../src/main/agent/integration-gates.js";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";

test("行程未就绪的完成反馈提示自动核验，不混入后续商业缺项", () => {
  const product = buildProductSnapshot({ destination: "日喀则", days: 3, productForm: "privateTour" });
  Object.assign(product.product.basicInfo!, { province: "西藏", subtitle: "行程", operationNotes: "按要求" });
  Object.assign(product.product.operations!, { pickupCity: "日喀则" });
  const result = agentCompletionGate(product, undefined, { ready: false, completion: 0, issues: [] },
    { runId: "run", hadWrites: true, hadRemoteWrites: false });
  assert.equal(result.verified, false);
  assert.match(result.message!, /itinerary.*当前缺项/);
  assert.match(result.message!, /resolve_itinerary_pois/);
  assert.match(result.message!, /自动进入后续阶段.*无需用户授权/);
  assert.doesNotMatch(result.message!, /套餐名称|定价|酒店候选/);
});
