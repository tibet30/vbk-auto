import type { AiProvider, Settings } from "./contracts-types.js";

export interface AiProviderProfile {
  value: AiProvider;
  label: string;
  shortLabel: string;
  defaultBaseUrl: string;
  defaultModel: string;
  modelOptions?: readonly AiModelOption[];
}

export interface AiModelOption {
  value: string;
  label: string;
}

export const AI_PROVIDER_PROFILES: readonly AiProviderProfile[] = [
  {
    value: "minimax",
    label: "MiniMax",
    shortLabel: "MiniMax",
    defaultBaseUrl: "https://api.minimaxi.com/v1",
    defaultModel: "MiniMax-M3",
  },
  {
    value: "deepseek",
    label: "Evolink",
    shortLabel: "Evolink",
    defaultBaseUrl: "https://api.evolink.ai/v1",
    defaultModel: "deepseek-v4-flash",
    modelOptions: [
      { value: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
      { value: "claude-fable-5", label: "Claude Fable 5" },
    ],
  },
] as const;

export function isAiProvider(value: unknown): value is AiProvider {
  return value === "minimax" || value === "deepseek";
}

export function aiProviderProfile(provider: AiProvider): AiProviderProfile {
  return AI_PROVIDER_PROFILES.find((profile) => profile.value === provider) ?? AI_PROVIDER_PROFILES[0];
}

export function aiModelOption(provider: AiProvider, model: string): AiModelOption | undefined {
  return aiProviderProfile(provider).modelOptions?.find((option) => option.value === model);
}

export function isSupportedAiModel(provider: AiProvider, model: string): boolean {
  const options = aiProviderProfile(provider).modelOptions;
  return !options?.length || options.some((option) => option.value === model);
}

export function aiProviderConfig(settings: Settings, provider: AiProvider) {
  if (provider === "deepseek") {
    return {
      baseUrl: settings.deepseekBaseUrl,
      model: settings.deepseekModel,
      hasKey: settings.hasDeepSeekKey,
    };
  }
  return {
    baseUrl: settings.minimaxBaseUrl,
    model: settings.minimaxModel,
    hasKey: settings.hasMiniMaxKey,
  };
}

/**
 * 当前激活的 AI 提供商是否已配置 API Key。
 * renderer 用它判断「空草稿是否自动触发首次 AI 生成」，避免
 * 切换到 Evolink 后仍误判 `settings.hasMiniMaxKey`，让没配 Key 的提供商
 * 偷偷触发请求并失败。settings 缺失时返回 false。
 */
export function hasActiveAiKey(settings: Settings | null | undefined): boolean {
  if (!settings) return false;
  return aiProviderConfig(settings, settings.aiProvider).hasKey;
}

/** 当前激活提供商的用户可读中性名称（"MiniMax" / "Evolink"），供日志和 UI 文案复用。 */
export function aiProviderLabel(settings: Settings | null | undefined): string {
  if (!settings) return aiProviderProfile("minimax").label;
  return aiProviderProfile(settings.aiProvider).label;
}
