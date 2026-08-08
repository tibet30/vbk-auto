import assert from "node:assert/strict";
import test from "node:test";
import { fetchAiModelList, parseAiModelList } from "../../src/main/infrastructure/ai-models.js";

test("解析 OpenAI 兼容模型列表，去重并保留展示名", () => {
  const models = parseAiModelList({
    data: [
      { id: "deepseek-v4-flash", owned_by: "evolink" },
      { id: "custom-model", display_name: "Custom Model", owned_by: "partner" },
      { id: "custom-model", name: "重复项" },
      { name: "缺少 ID" },
    ],
  }, "deepseek");

  assert.deepEqual(models, [
    { id: "custom-model", label: "Custom Model", ownedBy: "partner" },
    { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", ownedBy: "evolink" },
  ]);
});

test("刷新使用当前地址和临时 API Key 请求 /models", async () => {
  let requestedUrl = "";
  let authorization = "";
  const result = await fetchAiModelList({
    provider: "deepseek",
    baseUrl: "https://api.evolink.ai/v1/",
    apiKey: " temporary-key ",
  }, async () => "stored-key", async (input, init) => {
    requestedUrl = String(input);
    authorization = new Headers(init?.headers).get("Authorization") || "";
    return new Response(JSON.stringify({ data: [{ id: "model-b" }, { id: "model-a" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  assert.equal(requestedUrl, "https://api.evolink.ai/v1/models");
  assert.equal(authorization, "Bearer temporary-key");
  assert.deepEqual(result.models.map((model) => model.id), ["model-a", "model-b"]);
});

test("刷新可沿用 Keychain 密钥，并给出可恢复的鉴权错误", async () => {
  let readProvider = "";
  await assert.rejects(() => fetchAiModelList({
    provider: "deepseek",
    baseUrl: "https://api.evolink.ai/v1",
  }, async (provider) => {
    readProvider = provider;
    return "stored-key";
  }, async () => new Response("unauthorized", { status: 401 })), /API Key 无效/);
  assert.equal(readProvider, "deepseek");
});

test("空模型列表不会覆盖页面现有候选项", async () => {
  await assert.rejects(() => fetchAiModelList({
    provider: "deepseek",
    baseUrl: "https://api.evolink.ai/v1",
    apiKey: "test-key",
  }, async () => "", async () => new Response(JSON.stringify({ data: [] }), { status: 200 })), /没有返回可用模型/);
});
