import type { AiProvider, ConnectionTest, Settings } from "../../../shared/contracts";
import { aiModelOption, aiProviderConfig } from "../../../shared/contracts";

const STORAGE_PREFIX = "vbk:aiTest:";

export function readAiConnectionTest(provider: AiProvider, model: string): ConnectionTest | null {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${provider}:${model}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ConnectionTest>;
    if (
      parsed.provider === provider
      && typeof parsed.connected === "boolean"
      && typeof parsed.message === "string"
      && typeof parsed.baseUrl === "string"
      && parsed.model === model
      && typeof parsed.testedAt === "string"
    ) return parsed as ConnectionTest;
  } catch { /* Electron 隐私模式或存储损坏时按未测试处理。 */ }
  return null;
}

export function rememberAiConnectionTest(result: ConnectionTest) {
  try { localStorage.setItem(`${STORAGE_PREFIX}${result.provider}:${result.model}`, JSON.stringify(result)); } catch { /* 忽略 */ }
}

/**
 * 已保存模型可直接恢复；MiniMax 官方内置模型共用同一服务配置，可直接互切。
 * 供应商自动发现的模型可直接切换；未发现的动态模型仍须有成功连接收据。
 */
export function canQuickSwitchAiModel(
  settings: Settings,
  provider: AiProvider,
  model: string,
  receipt: ConnectionTest | null = readAiConnectionTest(provider, model),
  discovered = false,
): boolean {
  const config = aiProviderConfig(settings, provider);
  if (!config.hasKey) return false;
  if (config.model === model) return true;
  if (discovered) return true;
  if (provider === "minimax") return Boolean(aiModelOption(provider, model));
  return Boolean(receipt?.connected
    && receipt.provider === provider
    && receipt.baseUrl === config.baseUrl
    && receipt.model === model);
}
