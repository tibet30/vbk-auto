import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSafeAiServiceUrl,
  resolveAiConnectionInput,
  successfulAiConnectionTest,
} from "../../src/main/infrastructure/ai-settings.js";
import { canQuickSwitchAiModel } from "../../src/renderer/app/helpers/ai-test-receipts.js";
import type { ConnectionTest, Settings } from "../../src/shared/contracts.js";

const workspaceSettings: Settings = {
  aiProvider: "deepseek",
  minimaxBaseUrl: "https://api.minimaxi.com/v1",
  minimaxModel: "MiniMax-M3",
  deepseekBaseUrl: "https://api.evolink.ai/v1",
  deepseekModel: "deepseek-v4-flash",
  hasMiniMaxKey: false,
  hasDeepSeekKey: true,
  systemNotificationsEnabled: true,
  systemNotificationsSupported: true,
  dataPath: "/tmp/vbk-auto-test",
};

test("连接测试始终使用当前选择的提供商、地址和模型", async () => {
  const readProviders: string[] = [];
  const resolved = await resolveAiConnectionInput({
    provider: "deepseek",
    baseUrl: " https://api.evolink.ai/v1 ",
    model: " deepseek-v4-flash ",
  }, async (provider) => {
    readProviders.push(provider);
    return "stored-deepseek-key";
  });

  assert.deepEqual(readProviders, ["deepseek"]);
  assert.deepEqual(resolved, {
    provider: "deepseek",
    baseUrl: "https://api.evolink.ai/v1",
    model: "deepseek-v4-flash",
    apiKey: "stored-deepseek-key",
  });
});

test("页面临时输入的密钥优先于已保存密钥", async () => {
  const resolved = await resolveAiConnectionInput({
    provider: "minimax",
    baseUrl: "https://api.minimaxi.com/v1",
    model: "MiniMax-M3",
    apiKey: "  temporary-key  ",
  }, async () => "stored-key");
  assert.equal(resolved.apiKey, "temporary-key");
});

test("Evolink 接受刷新接口返回的动态模型 ID", async () => {
  const fable = await resolveAiConnectionInput({
    provider: "deepseek",
    baseUrl: "https://api.evolink.ai/v1",
    model: "claude-fable-5",
    apiKey: "test-key",
  }, async () => "");
  assert.equal(fable.model, "claude-fable-5");
  const dynamic = await resolveAiConnectionInput({
    provider: "deepseek",
    baseUrl: "https://api.evolink.ai/v1",
    model: "newly-released-model",
    apiKey: "test-key",
  }, async () => "");
  assert.equal(dynamic.model, "newly-released-model");
});

test("只允许 HTTPS 或本机 HTTP 服务地址", () => {
  assert.equal(assertSafeAiServiceUrl("https://api.example.com/v1").protocol, "https:");
  assert.equal(assertSafeAiServiceUrl("http://127.0.0.1:45791/v1").hostname, "127.0.0.1");
  assert.throws(() => assertSafeAiServiceUrl("http://api.example.com/v1"), /必须使用 https/);
});

test("成功结果携带本次测试的模型身份", () => {
  const result = successfulAiConnectionTest({
    provider: "deepseek",
    baseUrl: "https://api.evolink.ai/v1",
    model: "deepseek-v4-flash",
    apiKey: "secret",
  });
  assert.equal(result.connected, true);
  assert.equal(result.provider, "deepseek");
  assert.equal(result.model, "deepseek-v4-flash");
  assert.match(result.message, /Evolink.*DeepSeek V4 Flash.*连接测试通过/);
});

test("工作区允许 MiniMax 官方模型互切，动态模型仍须逐模型测试", () => {
  assert.equal(canQuickSwitchAiModel(workspaceSettings, "deepseek", "deepseek-v4-flash", null), true);
  assert.equal(canQuickSwitchAiModel(workspaceSettings, "deepseek", "claude-fable-5", null), false);
  assert.equal(canQuickSwitchAiModel(workspaceSettings, "deepseek", "claude-fable-5", null, true), true);
  const verified: ConnectionTest = {
    connected: true,
    message: "连接测试通过",
    provider: "deepseek",
    baseUrl: workspaceSettings.deepseekBaseUrl,
    model: "claude-fable-5",
    testedAt: "2026-11-16T00:00:00.000Z",
  };
  assert.equal(canQuickSwitchAiModel(workspaceSettings, "deepseek", "claude-fable-5", verified), true);
  assert.equal(canQuickSwitchAiModel(workspaceSettings, "deepseek", "claude-fable-5", {
    ...verified,
    baseUrl: "https://old.example/v1",
  }), false);
  const minimaxSettings = { ...workspaceSettings, hasMiniMaxKey: true };
  assert.equal(canQuickSwitchAiModel(minimaxSettings, "minimax", "MiniMax-M3", null), true);
  assert.equal(canQuickSwitchAiModel(minimaxSettings, "minimax", "MiniMax-M3.1-Flash", null), true);
  assert.equal(canQuickSwitchAiModel(minimaxSettings, "minimax", "unknown-minimax-model", null), false);
  assert.equal(canQuickSwitchAiModel(workspaceSettings, "minimax", "MiniMax-M3.1-Flash", null), false);
});
