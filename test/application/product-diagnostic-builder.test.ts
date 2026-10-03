import test from "node:test";
import assert from "node:assert/strict";
import { buildProductDiagnostics } from "../../src/main/application/product-diagnostic-builder.js";
import type { AgentSnapshot, ProductDetail } from "../../src/shared/contracts.js";

test("多轮失败按 run 配对工具调用和模型，同名工具调用 ID 不串参数", () => {
  const product: ProductDetail = { id: "test", name: "测试", status: "planning", updatedAt: "2026-10-03T00:00:00Z",
    product: { diagnostics: { creationInput: { destination: "潮州", productForm: "privateTour", days: 2 } } },
    messages: [], researchTasks: [] };
  const snapshot: AgentSnapshot = { localProductId: "test", run: null, events: [
    { id: "usage1", runId: "run1", type: "status", content: "", createdAt: product.updatedAt,
      data: { aiUsage: { model: "old-model", provider: "old-provider" } } },
    { id: "call1", runId: "run1", type: "tool_call", content: "", createdAt: product.updatedAt,
      data: { toolCallId: "same-id", name: "query_hotel", arguments: { city: "潮州" } } },
    { id: "fail1", runId: "run1", type: "tool_result", content: "", createdAt: product.updatedAt,
      data: { toolCallId: "same-id", error: "超时" } },
    { id: "call2", runId: "run2", type: "tool_call", content: "", createdAt: product.updatedAt,
      data: { toolCallId: "same-id", name: "query_poi", arguments: { city: "成都" } } },
    { id: "fail2", runId: "run2", type: "tool_result", content: "", createdAt: product.updatedAt,
      data: { toolCallId: "same-id", error: "失败" } },
  ] };
  const reports = buildProductDiagnostics(product, { appVersion: "test", platform: "darwin", arch: "arm64", model: "current-model" }, snapshot);
  assert.equal(reports.length, 3);
  assert.deepEqual(reports[1].failure?.arguments, { city: "潮州" });
  assert.equal(reports[1].failure?.tool, "query_hotel");
  assert.equal(reports[1].failure?.environment.model, "old-model");
  assert.deepEqual(reports[2].failure?.arguments, { city: "成都" });
  assert.equal(reports[2].failure?.tool, "query_poi");
  assert.equal(reports[2].failure?.environment.model, "current-model");
  const finalFailure = buildProductDiagnostics(product, { appVersion: "test", platform: "darwin", arch: "arm64" }, {
    ...snapshot, run: { id: "run2", status: "failed", error: "失败", createdAt: product.updatedAt, updatedAt: product.updatedAt },
  });
  assert.equal(finalFailure.length, 3, "same error propagated to run status must not count twice");
});
