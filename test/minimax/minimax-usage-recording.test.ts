import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { MiniMaxService } from "../../src/main/minimax/minimax.js";
import type { AiUsageEvent } from "../../src/shared/contracts-ai-usage.js";

test("reply 成功时 onEvent 收到 chat.reply 的 input/output tokens", async (t) => {
  const events: AiUsageEvent[] = [];
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          tool_calls: [{
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: JSON.stringify({
                reply: "已更新副标题。",
                patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "晋阳私享" }],
                questions: [],
                researchTasks: [],
              }),
            },
          }],
        },
      }],
      usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const service = new MiniMaxService({
    apiKey: "test-key",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: "test-model",
  });

  await service.reply({
    message: "调整副标题",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [{ day: 1 }] },
    history: [],
    usage: {
      localProductId: "prod-1",
      source: "chat.reply",
      onEvent: (event) => events.push(event),
    },
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].source, "chat.reply");
  assert.equal(events[0].status, "ok");
  assert.equal(events[0].inputTokens, 40);
  assert.equal(events[0].outputTokens, 12);
  assert.equal(events[0].totalTokens, 52);
});

test("testConnection 不产生 usage 事件", async (t) => {
  const events: AiUsageEvent[] = [];
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{ message: { content: "pong" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const service = new MiniMaxService({
    apiKey: "test-key",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: "test-model",
  });
  await service.testConnection();
  assert.equal(events.length, 0);
});
