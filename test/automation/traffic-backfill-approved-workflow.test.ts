import test from "node:test";
import assert from "node:assert/strict";
import { DraftAutomation } from "../../src/main/automation/automation.main/automation.main.class.js";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import { buildAgentApproval } from "../../src/main/agent/integration-gates.js";

test("approved traffic backfill runs before the completed-parent shortcut without rewriting parent phases", async () => {
  const product = buildProductSnapshot({ destination: "日喀则", days: 3, productForm: "privateTour" });
  product.productId = "79251201";
  Object.assign(product.product.basicInfo!, {
    subtitle: "藏地三日", province: "西藏", operationNotes: "按行程安排",
    userIdea: "启用飞机往返与火车往返子产品",
  });
  Object.assign(product.product.operations!, {
    pickupCity: "日喀则", trafficLine: { enabled: true, variants: ["flightRoundTrip", "trainRoundTrip"] },
  });
  product.product.itinerary = [1, 2, 3].map(day => ({ day, title: "日喀则游览", spots: [], description: "游览", hotel: "", meals: "" }));
  const scope = buildAgentApproval(product).scope;
  product.automation = { id: "recovered-parent", status: "succeeded", logs: [],
    phases: scope.filter(item => !item.endsWith(":trafficLine")).map(item => ({ phase: item.split(":")[1], status: "completed" })) } as any;
  const phases: string[] = [];
  const mock: any = {
    db: { getProduct: () => product, getAgentSnapshot: () => ({ run: { id: "agent" }, events: [
      { runId: "agent", type: "approval", data: { approval: { status: "approved", scope } } },
    ] }) },
    agentWriteGuard: () => {},
    runApprovedLocked: () => { throw Error("must not rewrite the completed parent"); },
    runOnePhaseLocked: async (id: string, phase: string) => { assert.equal(id, product.id); phases.push(phase); },
  };
  await DraftAutomation.prototype.executeApprovedWorkflow.call(mock, product.id);
  assert.deepEqual(phases, ["trafficLine", "preflight"]);
  assert.equal(product.productId, "79251201");
});
