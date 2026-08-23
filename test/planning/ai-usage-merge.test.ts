import assert from "node:assert/strict";
import test from "node:test";
import { appendAiUsage } from "../../src/main/ai/ai-usage-merge.js";
import type { AiUsageEvent, ProductAiUsage } from "../../src/shared/contracts-ai-usage.js";

function event(partial: Partial<AiUsageEvent> & Pick<AiUsageEvent, "id">): AiUsageEvent {
  return {
    source: "planning.structureLocation",
    model: "m",
    provider: "minimax",
    status: "ok",
    startedAt: "2026-08-23T10:00:00.000Z",
    endedAt: "2026-08-23T10:00:01.000Z",
    durationMs: 1000,
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    ...partial,
  };
}

test("appendAiUsage 按 id 去重并累加 Token", () => {
  const first = appendAiUsage(undefined, [event({ id: "a", inputTokens: 10, outputTokens: 5, totalTokens: 15 })]);
  const next = appendAiUsage(first, [
    event({ id: "a", inputTokens: 99, outputTokens: 99, totalTokens: 198 }),
    event({ id: "b", inputTokens: 20, outputTokens: 10, totalTokens: 30, runId: "run-2", startedAt: "2026-08-23T11:00:00.000Z", endedAt: "2026-08-23T11:00:02.000Z", durationMs: 2000 }),
  ]);
  assert.equal(next.events.length, 2);
  assert.equal(next.lifetime.calls, 2);
  assert.equal(next.lifetime.inputTokens, 30);
  assert.equal(next.lifetime.outputTokens, 15);
  assert.equal(next.lifetime.totalTokens, 45);
  assert.equal(next.lifetime.durationMs, 3000);
  assert.equal(next.latestRun.runId, "run-2");
  assert.equal(next.latestRun.totalTokens, 30);
});

test("appendAiUsage 保留 Tibet 已有 estimatedCostCny，不覆盖", () => {
  const existing: ProductAiUsage = {
    events: [event({ id: "a", estimatedCostCny: 1.25 })],
    lifetime: {
      calls: 1,
      durationMs: 1000,
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      tokensIncomplete: false,
      estimatedCostCny: 1.25,
    },
    latestRun: {
      calls: 1,
      durationMs: 1000,
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      tokensIncomplete: false,
      estimatedCostCny: 1.25,
    },
    byStage: [],
  };
  const next = appendAiUsage(existing, [event({ id: "b", inputTokens: 4, outputTokens: 1, totalTokens: 5, estimatedCostCny: null })]);
  assert.equal(next.events.find((item) => item.id === "a")?.estimatedCostCny, 1.25);
  assert.equal(next.lifetime.estimatedCostCny, 1.25);
});

test("appendAiUsage 任一 Token 缺失则 tokensIncomplete", () => {
  const next = appendAiUsage(undefined, [
    event({ id: "a", inputTokens: 10, outputTokens: 5, totalTokens: 15 }),
    event({ id: "b", inputTokens: null, outputTokens: null, totalTokens: null }),
  ]);
  assert.equal(next.lifetime.tokensIncomplete, true);
  assert.equal(next.lifetime.inputTokens, null);
  assert.equal(next.lifetime.outputTokens, null);
  assert.equal(next.lifetime.totalTokens, null);
});

test("appendAiUsage 超过 500 条丢最旧", () => {
  const many = Array.from({ length: 501 }, (_, index) => event({
    id: `e${index}`,
    startedAt: `2026-08-23T10:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
  }));
  const next = appendAiUsage(undefined, many);
  assert.equal(next.events.length, 500);
  assert.equal(next.events[0].id, "e1");
  assert.equal(next.events.at(-1)?.id, "e500");
});
