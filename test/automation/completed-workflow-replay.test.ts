import test from "node:test";
import assert from "node:assert/strict";
import { DraftAutomation } from "../../src/main/automation/automation.main/automation.main.class.js";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import { buildAgentApproval } from "../../src/main/agent/integration-gates.js";

test("完整重录的新确认不能被已完成草稿短路，普通恢复仍不重写", async () => {
  const product = buildProductSnapshot({ destination: "汕头", days: 2, productForm: "groupTour" });
  product.productId = "42";
  Object.assign(product.product.basicInfo!, { subtitle: "潮汕旅行", province: "广东", operationNotes: "按约定行程安排" });
  Object.assign(product.product.operations!, { pickupCity: "汕头" });
  product.product.itinerary = [1, 2].map(day => ({ day, title: "汕头游览", spots: [], description: "游览", hotel: "", meals: "" }));
  const scope = buildAgentApproval(product).scope;
  product.automation = { id: "old-run", status: "succeeded", logs: [],
    phases: scope.map(item => ({ phase: item.split(":")[1], status: "completed" })) } as any;
  for (const replayOfAutomationRunId of [undefined, "unrelated-run", "old-run"]) {
    const writes: unknown[] = [];
    const mock: any = {
      db: { getProduct: () => product, getAgentSnapshot: () => ({ run: { id: "agent-run" }, events: [
        { runId: "agent-run", type: "approval", data: { approval: { status: "approved", scope, replayOfAutomationRunId } } },
      ] }) },
      agentWriteGuard: () => {},
      runApprovedLocked: async (id: string, retryFrom: unknown) => { writes.push({ id, retryFrom }); },
      runOnePhaseLocked: async () => { throw Error("不应只重跑单个阶段"); },
    };
    await DraftAutomation.prototype.executeApprovedWorkflow.call(mock, product.id);
    assert.deepEqual(writes, replayOfAutomationRunId === "old-run" ? [{ id: product.id, retryFrom: undefined }] : []);
    assert.equal(product.productId, "42");
  }
});
