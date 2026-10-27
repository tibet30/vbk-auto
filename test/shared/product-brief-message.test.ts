import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProductBriefMessageContent,
  parseProductBriefMessage,
} from "../../src/shared/product-brief-message.js";

test("产品简报消息可编码为结构化内容并回读", () => {
  const content = buildProductBriefMessageContent({
    destination: "日喀则",
    productFormLabel: "私家团",
    days: 3,
    nights: 2,
    userIdea: "非遗中心或博物馆二选一，住当地4钻",
  });
  assert.deepEqual(parseProductBriefMessage(content), {
    type: "product_brief",
    destination: "日喀则",
    productFormLabel: "私家团",
    days: 3,
    nights: 2,
    userIdea: "非遗中心或博物馆二选一，住当地4钻",
  });
});

test("普通对话文本不会被误解析为产品简报", () => {
  assert.equal(parseProductBriefMessage("已创建「太原2天1晚私家团」。"), undefined);
  assert.equal(parseProductBriefMessage("安排轻松一点"), undefined);
});

test("产品简报保留创建前 AI 优化记录", () => {
  const ideaOptimization = {
    originalIdea: "带孩子去晋祠，慢一点。", optimizedIdea: "亲子慢游晋祠。",
    preservedItems: ["晋祠"], changes: [], recommendations: ["建议下午休息"], warnings: [],
    sourceFingerprint: "c".repeat(64), provider: "minimax", model: "MiniMax-M3",
    optimizedAt: "2026-10-24T08:00:00.000Z",
  };
  const content = buildProductBriefMessageContent({ destination: "太原", productFormLabel: "私家团", days: 2, nights: 1, userIdea: ideaOptimization.optimizedIdea, ideaOptimization });
  const parsed = parseProductBriefMessage(content);
  assert.equal(parsed?.ideaOptimization?.originalIdea, "带孩子去晋祠，慢一点。");
  assert.equal(parsed?.userIdea, "亲子慢游晋祠。");
});
