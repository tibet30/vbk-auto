import assert from "node:assert/strict";
import test from "node:test";
import { mergeAgentDiagnostics } from "../../src/main/application/product-diagnostics.js";
import type { AgentSnapshot, ProductDetail } from "../../src/shared/contracts.js";

const product: ProductDetail = {
  id: "product-1", name: "测试产品", status: "planning", updatedAt: "2026-09-28T02:55:00.000Z",
  product: {}, messages: [], researchTasks: [],
};

test("上报当前运行最近一次失败工具的名称、参数和错误，并脱敏", () => {
  const snapshot: AgentSnapshot = {
    localProductId: product.id,
    run: { id: "run-2", status: "paused", createdAt: "2026-09-28T02:38:00.000Z", updatedAt: "2026-09-28T02:55:00.000Z" },
    events: [
      { id: "old", runId: "run-1", type: "tool_result", createdAt: "2026-09-27T00:00:00.000Z", content: "", data: { error: "旧错误", toolCallId: "old-call" } },
      { id: "call", runId: "run-2", type: "tool_call", createdAt: "2026-09-28T02:54:00.000Z", content: "query_poi", data: {
        toolCallId: "call-1", name: "query_poi", arguments: { keyword: "金龙寺", apiKey: "secret-key", nested: { password: "secret-pass" } },
      } },
      { id: "result", runId: "run-2", type: "tool_result", createdAt: "2026-09-28T02:55:00.000Z", content: "工具失败", data: {
        toolCallId: "call-1", error: "查询失败，Authorization: Bearer secret-token",
      } },
      { id: "pause", runId: "run-2", type: "status", createdAt: "2026-09-28T02:55:01.000Z", content: "相同工具和参数连续失败两次", data: { status: "paused" } },
    ],
  };
  const diagnostics = mergeAgentDiagnostics(product, snapshot).diagnostics as Record<string, any>;
  assert.equal(diagnostics.runtime.lastToolFailure.name, "query_poi");
  assert.equal(diagnostics.runtime.lastToolFailure.arguments.keyword, "金龙寺");
  assert.equal(diagnostics.runtime.lastToolFailure.occurredAt, "2026-09-28T02:55:00.000Z");
  assert.match(diagnostics.runtime.lastToolFailure.error, /查询失败/);
  const serialized = JSON.stringify(diagnostics);
  for (const secret of ["secret-key", "secret-pass", "secret-token", "旧错误"]) assert.equal(serialized.includes(secret), false);
});

test("新运行没有工具错误时不沿用旧失败", () => {
  const snapshot: AgentSnapshot = {
    localProductId: product.id,
    run: { id: "run-2", status: "running", createdAt: "2026-09-28T03:00:00.000Z", updatedAt: "2026-09-28T03:00:00.000Z" },
    events: [{ id: "old", runId: "run-1", type: "tool_result", createdAt: "2026-09-28T02:55:00.000Z", content: "", data: { error: "旧错误", toolCallId: "old-call" } }],
  };
  const stale = { ...product, product: { diagnostics: { runtime: { lastToolFailure: { name: "旧工具" } } } } };
  const diagnostics = mergeAgentDiagnostics(stale, snapshot).diagnostics as Record<string, any>;
  assert.equal(diagnostics.runtime.lastToolFailure, undefined);
});
