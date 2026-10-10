import test from "node:test";
import assert from "node:assert/strict";
import { nextPreparationLoopDecision } from "../../src/main/agent/core-preparation.js";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import { PRODUCT_PREPARATION_INSTRUCTION } from "../../src/main/agent/preparation-run.js";
import type { AgentSnapshot } from "../../src/shared/contracts.js";

test("酒店资料自动回答后必须给模型落实机会，无业务进展三轮后停止重复问答", () => {
  const product = buildProductSnapshot({ destination: "潮汕", days: 2, productForm: "privateTour" });
  Object.assign(product.product.basicInfo!, { province: "广东", subtitle: "沿已确认行程", operationNotes: "按原要求" });
  Object.assign(product.product.operations!, { pickupCity: "潮汕", transport: "charter" });
  product.product.itinerary = [
    { day: 1, title: "汕头", description: "游览", hotel: "汕头酒店", meals: "自理", spots: [{ name: "小公园", poiName: "小公园", poiId: 1 }] },
    { day: 2, title: "返程", description: "自由活动后返程", hotel: "无", meals: "自理", spots: [{ name: "自由活动", kind: "free" }] },
  ];
  const deps = { tools: [], accountFor: async () => ({ accountKey: "a", productVersion: "v" }), preparationProduct: () => product };
  const snapshot: AgentSnapshot = { localProductId: product.id, run: { id: "r", status: "running", createdAt: "t", updatedAt: "t", intentVersion: "v" }, events: [
    { id: "u", runId: "r", type: "user", createdAt: "t", content: PRODUCT_PREPARATION_INSTRUCTION },
  ] };
  const initial = nextPreparationLoopDecision(deps, snapshot);
  assert.equal(initial.kind, "execute");
  if (initial.kind !== "execute") throw new Error("missing action");
  assert.equal(initial.action.node, "hotelResolution");
  const key = initial.action.progressKey;
  snapshot.events.push({ id: "q", runId: "r", type: "tool_call", createdAt: "t", content: "ask_user",
    data: { toolCallId: "q", hotelAvailabilityInput: true, progressKey: key } });
  snapshot.events.push({ id: "answer", runId: "r", type: "tool_result", createdAt: "t", content: "hotel answer",
    data: { toolCallId: "q", automaticProductInput: true, answers: { hotel1: "同地点检索" } } });
  for (let index = 0; index < 3; index += 1) {
    const next = nextPreparationLoopDecision(deps, snapshot);
    assert.equal(next.kind, "model");
    if (next.kind !== "model") throw new Error("missing model window");
    assert.equal(next.hotelInputModelWindow, true);
    snapshot.events.push({ id: `m${index}`, runId: "r", type: "status", createdAt: "t", content: "落实答案",
      data: { hotelInputModelWindow: true, progressKey: key } });
  }
  assert.equal(nextPreparationLoopDecision(deps, snapshot).kind, "pause");
  (product.product.itinerary![0] as unknown as Record<string, unknown>).hotelRequirement = {
    cityName: "汕头", anchorName: "汕头万象城", diamond: 5,
  };
  assert.equal(nextPreparationLoopDecision(deps, snapshot).kind, "execute", "真实检索条件改变后不能沿用旧进度的重试计数");
  snapshot.events.push({ id: "new-user", runId: "r", type: "user", createdAt: "t", content: "按新住宿地点重试" });
  assert.equal(nextPreparationLoopDecision(deps, snapshot).kind, "execute", "新的用户指示重新打开落实机会");
});
