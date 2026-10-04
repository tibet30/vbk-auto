import assert from "node:assert/strict";
import test from "node:test";
import { ProductMutationService } from "../../src/main/application/product-mutation-service.js";
import { nextPreparationLoopDecision } from "../../src/main/agent/core-preparation.js";
import { validateSchema } from "../../src/main/agent/core-validation.js";
import { createAgentBusinessTools } from "../../src/main/agent/integration.js";
import { PRODUCT_PREPARATION_INSTRUCTION } from "../../src/main/agent/preparation-run.js";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import type { ProductDetail, ProductSummary } from "../../src/shared/contracts.js";

function product(): ProductDetail {
  const value = buildProductSnapshot({ destination: "潮州", days: 2, productForm: "privateTour" });
  Object.assign(value.product.basicInfo!, { province: "广东", subtitle: "潮州两日私家团", operationNotes: "按用户日程安排" });
  Object.assign(value.product.operations!, { pickupCity: "潮州", transport: "charter" });
  value.product.itinerary = [{ day: 1, title: "潮州古城", description: "游览广济桥", hotel: "潮州酒店", meals: "自理", spots: [{ name: "广济桥", poiName: "广济桥", poiId: 101 }] },
    { day: 2, title: "返程", description: "送站返程", hotel: "无", meals: "自理", spots: [{ name: "送站", kind: "other" }] }];
  return value;
}

test("hotel 显式空字符串可写本地，title/name 空字符串仍被拒绝", async () => {
  let saved = product();
  const store = {
    getProduct: () => saved,
    updateProduct: (_id: string, next: Record<string, unknown>, status?: ProductSummary["status"]) => { saved = { ...saved, product: next, status: status ?? saved.status }; },
    getSetting: () => undefined, addResearchTask: () => "task", markResearchTasksSatisfied: () => undefined,
    reopenKindSupersededPoiResearchTasks: () => undefined, markResearchTasksSatisfiedByProduct: () => ({ updated: 0, taskIds: [] }),
  };
  const tools = createAgentBusinessTools({ db: store as never, browser: {} as never, automation: {} as never,
    productWorkflows: { runExclusive: async (_id: string, _kind: string, work: () => Promise<unknown>) => work(), runVbkPageExclusive: async <T>(work: () => Promise<T>) => work() } as never,
    productMutations: new ProductMutationService(store), generateStage: async () => ({ reply: "", modules: [] }),
    disambiguatePoiOption: async () => ({ pickedText: null, confidence: 0 }), disambiguateStationOption: async () => ({ pickedText: null, reasoning: "" }), emitProduct: () => undefined,
  });
  const patch = tools.find((tool) => tool.name === "patch_product")!;
  const payload = { patch: { itinerary: [{ day: 1, hotel: "" }] } };
  assert.equal(validateSchema(patch.parameters, payload), undefined);
  await patch.execute(payload, { localProductId: saved.id, accountKey: "a", productVersion: "v" });
  assert.equal(saved.product.itinerary?.[0]?.hotel, "");
  assert.equal(saved.product.itinerary?.[0]?.spots?.[0]?.poiId, 101);
  assert.match(validateSchema(patch.parameters, { patch: { itinerary: [{ day: 1, title: "" }] } }) ?? "", /title/);
  assert.match(validateSchema(patch.parameters, { patch: { itinerary: [{ day: 1, spots: [{ name: "" }] }] } }) ?? "", /name/);
});

test("暂停优先报告修复窗口最后一个被拒绝的 patch", () => {
  const current = product();
  const base = { localProductId: current.id, run: { id: "run", status: "running" as const, intentVersion: "v", createdAt: "now", updatedAt: "now" }, events: [
    { id: "user", runId: "run", type: "user" as const, content: PRODUCT_PREPARATION_INSTRUCTION, createdAt: "now" },
  ] };
  const deps = { tools: [], accountFor: async () => ({ accountKey: "a", productVersion: "v" }), preparationProduct: () => current };
  const first = nextPreparationLoopDecision(deps, base);
  assert.equal(first.kind, "execute");
  for (const index of [1, 2]) {
    base.events.push({ id: `auto-${index}`, runId: "run", type: "tool_call", content: first.action.name, createdAt: "now", data: { toolCallId: `auto-${index}`, name: first.action.name, deterministicPreparation: true, progressKey: first.action.progressKey } } as never);
    base.events.push({ id: `result-${index}`, runId: "run", type: "tool_result", content: "generator failed", createdAt: "now", data: { toolCallId: `auto-${index}` } } as never);
  }
  base.events.push({ id: "repair", runId: "run", type: "status", content: "repair", createdAt: "now", data: { deterministicPreparationModelRepair: true, name: first.action.name, progressKey: first.action.progressKey } } as never);
  base.events.push({ id: "patch", runId: "run", type: "tool_call", content: "patch_product", createdAt: "now", data: { toolCallId: "patch", name: "patch_product" } } as never);
  base.events.push({ id: "patch-result", runId: "run", type: "tool_result", content: "参数无效：patch.itinerary[1].hotel 必须是非空字符串", createdAt: "now", data: { toolCallId: "patch", executionRejected: true } } as never);
  base.events.push({ id: "read", runId: "run", type: "tool_call", content: "read_product", createdAt: "now", data: { toolCallId: "read", name: "read_product" } } as never);
  base.events.push({ id: "read-result", runId: "run", type: "tool_result", content: "无关的只读产品快照", createdAt: "now", data: { toolCallId: "read" } } as never);
  const paused = nextPreparationLoopDecision(deps, base);
  assert.equal(paused.kind, "pause");
  assert.match(paused.reason, /patch\.itinerary\[1\]\.hotel/);
  assert.doesNotMatch(paused.reason, /最近结果：generator failed/);
});
