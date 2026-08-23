import assert from "node:assert/strict";
import test from "node:test";
import {
  AI_USAGE_USD_TO_CNY,
  estimateAiUsageCostCny,
  lookupAiTokenRateCny,
} from "../../src/shared/ai-usage-cost.js";
import { toAiUsageEvent } from "../../src/main/ai/completion-usage.js";

test("lookupAiTokenRateCny 识别 MiniMax-M3 与大小写变体", () => {
  const rate = lookupAiTokenRateCny("MiniMax-M3");
  assert.ok(rate);
  assert.equal(rate.inputPerMillion, 2.1);
  assert.equal(rate.outputPerMillion, 8.4);
  assert.equal(rate.cachedPerMillion, 0.42);
  assert.equal(lookupAiTokenRateCny("minimax-m3")?.inputPerMillion, 2.1);
  assert.equal(lookupAiTokenRateCny("unknown-model"), null);
});

test("estimateAiUsageCostCny MiniMax-M3 按刊例价折算", () => {
  // 1M in + 1M out = 2.1 + 8.4 = 10.5
  assert.equal(
    estimateAiUsageCostCny({ model: "MiniMax-M3", inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    10.5,
  );
  // 100k in + 20k out = 0.21 + 0.168 = 0.378
  assert.equal(
    estimateAiUsageCostCny({ model: "MiniMax-M3", inputTokens: 100_000, outputTokens: 20_000 }),
    0.378,
  );
});

test("estimateAiUsageCostCny 缓存命中按 cached 单价拆分", () => {
  // 80k uncached @2.1 + 20k cached @0.42 + 10k out @8.4
  // = 0.168 + 0.0084 + 0.084 = 0.2604
  assert.equal(
    estimateAiUsageCostCny({
      model: "MiniMax-M3",
      inputTokens: 100_000,
      outputTokens: 10_000,
      cachedTokens: 20_000,
    }),
    0.2604,
  );
});

test("estimateAiUsageCostCny Evolink deepseek-v4-flash 用 USD×7.2", () => {
  const expected = Math.round((0.147 * AI_USAGE_USD_TO_CNY + 0.294 * AI_USAGE_USD_TO_CNY) * 10_000) / 10_000;
  assert.equal(
    estimateAiUsageCostCny({
      model: "deepseek-v4-flash",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    }),
    expected,
  );
});

test("estimateAiUsageCostCny Token 缺失或未知模型返回 null", () => {
  assert.equal(estimateAiUsageCostCny({ model: "MiniMax-M3", inputTokens: null, outputTokens: 1 }), null);
  assert.equal(estimateAiUsageCostCny({ model: "MiniMax-M3", inputTokens: 1, outputTokens: null }), null);
  assert.equal(estimateAiUsageCostCny({ model: "nope", inputTokens: 10, outputTokens: 5 }), null);
});

test("toAiUsageEvent 写入本地 estimatedCostCny", () => {
  const event = toAiUsageEvent({
    source: "chat.reply",
    model: "MiniMax-M3",
    provider: "minimax",
    durationMs: 100,
    response: {
      usage: { prompt_tokens: 100_000, completion_tokens: 20_000, total_tokens: 120_000 },
    },
  });
  assert.equal(event.estimatedCostCny, 0.378);
  assert.equal(event.inputTokens, 100_000);
  assert.equal(event.outputTokens, 20_000);
});

test("toAiUsageEvent 未知模型时 estimatedCostCny 为 null", () => {
  const event = toAiUsageEvent({
    source: "chat.reply",
    model: "mystery-model",
    provider: "minimax",
    durationMs: 10,
    response: {
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  });
  assert.equal(event.estimatedCostCny, null);
});
