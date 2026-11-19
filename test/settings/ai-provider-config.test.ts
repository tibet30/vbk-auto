import assert from "node:assert/strict";
import test from "node:test";
import {
  AI_PROVIDER_PROFILES,
  aiModelChoices,
  aiModelOption,
  aiProviderConfig,
  aiProviderLabel,
  aiProviderProfile,
  hasActiveAiKey,
  isAiProvider,
  isSupportedAiModel,
  type Settings,
} from "../../src/shared/contracts.js";

const settings: Settings = {
  aiProvider: "minimax",
  minimaxBaseUrl: "https://minimax.example/v1",
  minimaxModel: "MiniMax-M3",
  deepseekBaseUrl: "https://deepseek.example/v1",
  deepseekModel: "deepseek-v4-flash",
  hasMiniMaxKey: true,
  hasDeepSeekKey: false,
  dataPath: "/tmp/vbk-auto-test",
};

const evolinkSettings: Settings = {
  ...settings,
  aiProvider: "deepseek",
  hasMiniMaxKey: false,
  hasDeepSeekKey: true,
};

test("每个 AI 提供商都保留自己的地址、模型和密钥状态", () => {
  assert.deepEqual(aiProviderConfig(settings, "minimax"), {
    baseUrl: "https://minimax.example/v1",
    model: "MiniMax-M3",
    hasKey: true,
  });
  assert.deepEqual(aiProviderConfig(settings, "deepseek"), {
    baseUrl: "https://deepseek.example/v1",
    model: "deepseek-v4-flash",
    hasKey: false,
  });
});

test("只接受应用支持的 AI 提供商", () => {
  assert.equal(isAiProvider("minimax"), true);
  assert.equal(isAiProvider("deepseek"), true);
  assert.equal(isAiProvider("unknown"), false);
  assert.equal(isAiProvider(undefined), false);
});

test("提供商预设可按值稳定查找", () => {
  assert.equal(AI_PROVIDER_PROFILES.length, 2);
  assert.deepEqual(aiProviderProfile("minimax").modelOptions?.map((option) => option.value), [
    "MiniMax-M3",
    "MiniMax-M3.1-Flash",
  ]);
  assert.equal(aiProviderProfile("deepseek").defaultModel, "deepseek-v4-flash");
  assert.deepEqual(aiProviderProfile("deepseek").modelOptions?.map((option) => option.value), [
    "deepseek-v4-flash",
    "claude-fable-5",
  ]);
  assert.equal(aiModelOption("deepseek", "claude-fable-5")?.label, "Claude Fable 5");
  assert.equal(aiModelOption("minimax", "MiniMax-M3.1-Flash")?.label, "MiniMax M3.1 Flash");
  assert.equal(isSupportedAiModel("minimax", "MiniMax-M3.1-Flash"), true);
  assert.equal(isSupportedAiModel("deepseek", "claude-fable-5"), true);
  assert.equal(isSupportedAiModel("deepseek", "made-up-model"), false);
});

test("对话模型选择器列出内置模型、当前动态模型和配置状态", () => {
  const choices = aiModelChoices({
    ...settings,
    aiProvider: "deepseek",
    deepseekModel: "new-model",
    hasDeepSeekKey: true,
  });
  assert.deepEqual(choices.map(({ provider, value, configured, active }) => ({ provider, value, configured, active })), [
    { provider: "minimax", value: "MiniMax-M3", configured: true, active: false },
    { provider: "minimax", value: "MiniMax-M3.1-Flash", configured: true, active: false },
    { provider: "deepseek", value: "new-model", configured: true, active: true },
    { provider: "deepseek", value: "deepseek-v4-flash", configured: true, active: false },
    { provider: "deepseek", value: "claude-fable-5", configured: true, active: false },
  ]);
});

test("对话模型选择器优先采用供应商自动发现的模型目录", () => {
  const choices = aiModelChoices(settings, {
    deepseek: [
      { id: "live-model-a", label: "Live Model A" },
      { id: "live-model-b", label: "Live Model B" },
    ],
  });
  assert.deepEqual(
    choices.filter((choice) => choice.provider === "deepseek").map(({ value, label }) => ({ value, label })),
    [
      { value: "deepseek-v4-flash", label: "deepseek-v4-flash" },
      { value: "live-model-a", label: "Live Model A" },
      { value: "live-model-b", label: "Live Model B" },
    ],
  );
});

test("hasActiveAiKey 仅依赖当前激活的提供商", () => {
  // 当前激活 MiniMax 且有 MiniMax Key → 可触发空草稿自动补齐
  assert.equal(hasActiveAiKey(settings), true);
  // 当前激活 MiniMax 但没有 MiniMax Key（即便 Evolink 配好了也算空）→ 不可触发
  assert.equal(hasActiveAiKey({ ...settings, hasMiniMaxKey: false }), false);
  // 当前激活 Evolink → 应当只看 Evolink Key
  assert.equal(hasActiveAiKey(evolinkSettings), true);
  assert.equal(hasActiveAiKey({ ...evolinkSettings, hasDeepSeekKey: false }), false);
  // settings 缺失时安全返回 false，避免空草稿触发出错
  assert.equal(hasActiveAiKey(null), false);
});

test("aiProviderLabel 根据当前激活提供商返回用户可读的中性名", () => {
  assert.equal(aiProviderLabel(settings), "MiniMax");
  assert.equal(aiProviderLabel(evolinkSettings), "Evolink");
});
