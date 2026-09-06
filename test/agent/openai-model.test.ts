import assert from "node:assert/strict";
import test from "node:test";
import { OpenAIAgentModel, parseOpenAIToolCalls } from "../../src/main/agent/openai-model.js";

test("OpenAI adapter preserves malformed function arguments for protocol feedback", () => {
  const [call] = parseOpenAIToolCalls([{ id: "bad", function: { name: "write", arguments: "{oops" } }]);
  assert.equal(call?.id, "bad");
  assert.equal(call?.rawArguments, "{oops");
  assert.ok(call?.argumentError);
  assert.deepEqual(call?.arguments, {});
});

test("OpenAI adapter accepts only JSON objects as function arguments", () => {
  const [arrayCall, objectCall] = parseOpenAIToolCalls([
    { id: "array", function: { name: "read", arguments: "[]" } },
    { id: "object", function: { name: "read", arguments: "{\"city\":\"成都\"}" } },
  ]);
  assert.ok(arrayCall?.argumentError);
  assert.equal(objectCall?.argumentError, undefined);
  assert.deepEqual(objectCall?.arguments, { city: "成都" });
});

function modelWithChunks(chunks: unknown[], capture?: (request: unknown) => void): OpenAIAgentModel {
  const model = new OpenAIAgentModel({ apiKey: "test", baseUrl: "https://example.invalid", model: "test" });
  (model as unknown as { client: { chat: { completions: { create(request: unknown): Promise<AsyncIterable<unknown>> } } } }).client = {
    chat: { completions: { create: async (request) => {
      capture?.(request);
      return { async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk; } };
    } } },
  };
  return model;
}

test("OpenAI adapter rejects an empty choices response", async () => {
  const model = modelWithChunks([{ choices: [] }]);
  await assert.rejects(model.complete({ messages: [], tools: [] }), /模型响应为空/);
});

test("OpenAI adapter rejects a response truncated by the provider length limit", async () => {
  const model = modelWithChunks([{ choices: [{ finish_reason: "length", delta: {} }] }]);
  await assert.rejects(model.complete({ messages: [], tools: [] }), /长度限制被截断/);
});

test("OpenAI adapter streams public text and assembles fragmented tool calls", async () => {
  const visible: string[] = [];
  let request: unknown;
  const model=modelWithChunks([
    {choices:[{finish_reason:null,delta:{content:'<think>内部'}}]},
    {choices:[{finish_reason:null,delta:{content:'推演</think>请补充'}}]},
    {choices:[{finish_reason:null,delta:{content:'套餐名称。',tool_calls:[{index:0,id:'read',function:{name:'read_',arguments:'{'}}]}}]},
    {choices:[{finish_reason:'tool_calls',delta:{tool_calls:[{index:0,function:{name:'product',arguments:'}'}}]}}],usage:{prompt_tokens:12,completion_tokens:8}},
  ], (value) => { request = value; });
  const result=await model.complete({messages:[],tools:[],onContent:(content)=>visible.push(content)});
  assert.equal(result.content,'请补充套餐名称。');
  assert.equal(result.toolCalls[0]?.name,'read_product');
  assert.deepEqual(result.toolCalls[0]?.arguments,{});
  assert.deepEqual(visible,['请补充','请补充套餐名称。']);
  assert.equal((request as {stream?:boolean}).stream,true);
  assert.deepEqual(result.usage,{inputTokens:12,outputTokens:8});
});

test("OpenAI adapter rejects an early stream EOF", async () => {
  const model = modelWithChunks([{ choices: [{ finish_reason: null, delta: { content: "未完成" } }] }]);
  await assert.rejects(model.complete({ messages: [], tools: [] }), /提前结束/);
});
