import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { toModelMessages } from "../../src/main/agent/ai-sdk-transcript.js";
import { AiSdkAgentModel } from "../../src/main/agent/ai-sdk-model.js";
import { describeAgentFailure } from "../../src/main/agent/agent-failure.js";
import { isTransientModelError } from "../../src/main/agent/transient-error.js";
import type { AgentModelMessage } from "../../src/main/agent/types.js";

test("assistant text and every tool call stay in one message", () => {
  const messages = toModelMessages([
    { role: "user", content: "帮我查景点" },
    {
      role: "assistant",
      content: "先查两个景点。",
      toolCalls: [
        { id: "call_a", name: "query_poi", arguments: { keyword: "故宫" } },
        { id: "call_b", name: "query_poi", arguments: { keyword: "颐和园" } },
      ],
    },
    { role: "tool", content: "故宫结果", toolCallId: "call_a" },
    { role: "tool", content: "颐和园结果", toolCallId: "call_b" },
  ]);

  assert.equal(messages.length, 4);
  const assistant = messages[1] as { role: string; content: Array<Record<string, unknown>> };
  assert.equal(assistant.role, "assistant");
  assert.deepEqual(assistant.content.map((part) => part.type), ["text", "tool-call", "tool-call"]);
  assert.equal(assistant.content[1]!.toolCallId, "call_a");
  assert.deepEqual(assistant.content[1]!.input, { keyword: "故宫" });
});

test("tool results carry the tool name resolved from their call id", () => {
  const messages = toModelMessages([
    { role: "assistant", content: "", toolCalls: [{ id: "call_a", name: "read_product", arguments: {} }] },
    { role: "tool", content: "读取成功", toolCallId: "call_a" },
    { role: "tool", content: "无主结果", toolCallId: "orphan" },
  ]);

  const [known, orphan] = messages.slice(1) as Array<{ content: Array<Record<string, unknown>> }>;
  assert.equal(known!.content[0]!.toolName, "read_product");
  assert.deepEqual(known!.content[0]!.output, { type: "text", value: "读取成功" });
  assert.equal(orphan!.content[0]!.toolName, "unknown");
});

test("a system message keeps its position between tool results", () => {
  const messages = toModelMessages([
    { role: "assistant", content: "", toolCalls: [{ id: "call_a", name: "write", arguments: {} }] },
    { role: "tool", content: "已写入", toolCallId: "call_a" },
    { role: "system", content: "完成检查反馈：缺少回读" },
  ]);

  assert.deepEqual(messages.map((message) => message.role), ["assistant", "tool", "system"]);
});

function sseServer(chunks: unknown[]) {
  return createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    response.end("data: [DONE]\n\n");
  });
}

function chunk(delta: Record<string, unknown>, finishReason: string | null = null) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 0,
    model: "test-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

async function withServer<T>(chunks: unknown[], run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = sseServer(chunks);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("streams visible text and hides provider reasoning", async () => {
  const visible: string[] = [];
  const messages: AgentModelMessage[] = [{ role: "user", content: "你好" }];
  await withServer([
    chunk({ content: "<think>内部推演" }),
    chunk({ content: "推理完成</think>请补充" }),
    chunk({ content: "套餐名称。" }),
    chunk({}, "stop"),
  ], async (baseUrl) => {
    const model = new AiSdkAgentModel({ apiKey: "test", baseUrl, model: "test-model" });
    const result = await model.complete({ messages, tools: [], onContent: (content) => { visible.push(content); } });
    assert.equal(result.content, "请补充套餐名称。");
    assert.deepEqual(visible, ["请补充", "请补充套餐名称。"]);
    assert.equal(result.toolCalls?.length, 0);
  });
});

test("assembles tool calls with parsed arguments", async () => {
  const messages: AgentModelMessage[] = [{ role: "user", content: "查故宫" }];
  await withServer([
    chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "query_poi", arguments: "{\"keyword\"" } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: ":\"故宫\"}" } }] }),
    chunk({}, "tool_calls"),
  ], async (baseUrl) => {
    const model = new AiSdkAgentModel({ apiKey: "test", baseUrl, model: "test-model" });
    const result = await model.complete({ messages, tools: [] });
    assert.equal(result.toolCalls?.[0]?.name, "query_poi");
    assert.deepEqual(result.toolCalls?.[0]?.arguments, { keyword: "故宫" });
    assert.equal(result.toolCalls?.[0]?.rawArguments, "{\"keyword\":\"故宫\"}");
  });
});

test("rejects a response truncated by the provider length limit", async () => {
  const messages: AgentModelMessage[] = [{ role: "user", content: "写很长的行程" }];
  await withServer([
    chunk({ content: "第一天" }),
    chunk({}, "length"),
  ], async (baseUrl) => {
    const model = new AiSdkAgentModel({ apiKey: "test", baseUrl, model: "test-model" });
    await assert.rejects(model.complete({ messages, tools: [] }), /长度限制被截断/);
  });
});

test("passes provider body fields and tool schemas through the request", async () => {
  let body: Record<string, unknown> = {};
  const server = createServer((request, response) => {
    const parts: Buffer[] = [];
    request.on("data", (part: Buffer) => parts.push(part));
    request.on("end", () => {
      body = JSON.parse(Buffer.concat(parts).toString("utf8")) as Record<string, unknown>;
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.write(`data: ${JSON.stringify(chunk({ content: "ok" }, "stop"))}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  try {
    const model = new AiSdkAgentModel({
      apiKey: "test",
      baseUrl: `http://127.0.0.1:${address.port}`,
      model: "test-model",
      extraParams: { thinking: { type: "disabled" }, service_tier: "standard" },
    });
    await model.complete({
      messages: [{ role: "user", content: "hi" }],
      tools: [{
        name: "query_poi",
        description: "查景点",
        parameters: { type: "object", properties: { keyword: { type: "string" } }, required: ["keyword"] },
      }],
    });
    assert.deepEqual(body.thinking, { type: "disabled" });
    assert.equal(body.service_tier, "standard");
    const tools = body.tools as Array<{ function: { name: string; parameters: unknown } }>;
    assert.equal(tools[0]?.function.name, "query_poi");
    assert.deepEqual(tools[0]?.function.parameters, {
      type: "object",
      properties: { keyword: { type: "string" } },
      required: ["keyword"],
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("keeps a mid-conversation system message in place", async () => {
  let body: Record<string, unknown> = {};
  const server = createServer((request, response) => {
    const parts: Buffer[] = [];
    request.on("data", (part: Buffer) => parts.push(part));
    request.on("end", () => {
      body = JSON.parse(Buffer.concat(parts).toString("utf8")) as Record<string, unknown>;
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.write(`data: ${JSON.stringify(chunk({ content: "ok" }, "stop"))}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  try {
    const model = new AiSdkAgentModel({
      apiKey: "test",
      baseUrl: `http://127.0.0.1:${address.port}`,
      model: "test-model",
    });
    await model.complete({
      messages: [
        { role: "system", content: "你是助手" },
        { role: "assistant", content: "", toolCalls: [{ id: "call_a", name: "write", arguments: {} }] },
        { role: "tool", content: "已写入", toolCallId: "call_a" },
        { role: "system", content: "完成检查反馈：缺少回读" },
      ],
      tools: [],
    });
    const messages = body.messages as Array<{ role: string; tool_call_id?: string }>;
    assert.deepEqual(messages.map((message) => message.role), ["system", "assistant", "tool", "system"]);
    assert.equal(messages[2]?.tool_call_id, "call_a");
    assert.match(JSON.stringify(messages[3]), /完成检查反馈/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("forwards cached prompt tokens through usage", async () => {  const usages: Array<{ inputTokens?: number; outputTokens?: number; cachedTokens?: number }> = [];
  const messages: AgentModelMessage[] = [{ role: "user", content: "你好" }];
  await withServer([
    { ...chunk({ content: "完成" }, "stop"), usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 40 } } },
  ], async (baseUrl) => {
    const model = new AiSdkAgentModel({ apiKey: "test", baseUrl, model: "test-model", onUsage: (usage) => { usages.push(usage); } });
    const result = await model.complete({ messages, tools: [] });
    assert.equal(result.content, "完成");
    assert.equal(usages.at(-1)?.inputTokens, 100);
    assert.equal(usages.at(-1)?.cachedTokens, 40);
  });
});

test("an ended stream without content surfaces a retryable Chinese failure", async () => {
  const messages: AgentModelMessage[] = [{ role: "user", content: "你好" }];
  await withServer([], async (baseUrl) => {
    const model = new AiSdkAgentModel({ apiKey: "test", baseUrl, model: "test-model" });
    await assert.rejects(model.complete({ messages, tools: [] }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /未返回可用内容/u);
      assert.doesNotMatch(error.message, /no output generated|finish reason/i);
      assert.equal(isTransientModelError(error), true, "空流必须交给上层自动重试");
      assert.match(describeAgentFailure(error).message, /没有返回任何内容/u);
      return true;
    });
  });
});
