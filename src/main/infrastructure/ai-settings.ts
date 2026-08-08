import type { AiConnectionTestInput, AiProvider, ConnectionTest } from "../../shared/contracts.js";
import { aiModelOption, aiProviderProfile, isAiProvider } from "../../shared/contracts.js";

export interface ResolvedAiConnectionInput {
  provider: AiProvider;
  baseUrl: string;
  model: string;
  apiKey: string;
}

/**
 * 校验并解析一个 AI 服务地址。必须 https；http 仅允许 127.0.0.1 / localhost / [::1]
 * （用于本机调试）。
 *
 * @param value 待校验的 URL 字符串
 * @returns 解析后的 URL 对象
 * @throws 当协议不合法或字符串本身不是合法 URL 时
 */
export function assertSafeAiServiceUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("服务地址格式不正确。");
  }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new Error("服务地址必须使用 https://（本机调试可用 http://127.0.0.1）。");
  }
  return parsed;
}

export async function resolveAiConnectionInput(
  input: AiConnectionTestInput,
  readStoredKey: (provider: AiProvider) => Promise<string>,
): Promise<ResolvedAiConnectionInput> {
  if (!isAiProvider(input?.provider)) throw new Error("请选择要测试的 AI 提供商。");
  const baseUrl = typeof input.baseUrl === "string" ? input.baseUrl.trim() : "";
  assertSafeAiServiceUrl(baseUrl);
  const model = typeof input.model === "string" ? input.model.trim() : "";
  if (!model) throw new Error("请填写要测试的模型名。");
  const apiKey = typeof input.apiKey === "string" && input.apiKey.trim()
    ? input.apiKey.trim()
    : await readStoredKey(input.provider);
  if (!apiKey) throw new Error(`请先填写 ${aiProviderProfile(input.provider).shortLabel} API Key。`);
  return { provider: input.provider, baseUrl, model, apiKey };
}

export function successfulAiConnectionTest(input: ResolvedAiConnectionInput): ConnectionTest {
  const profile = aiProviderProfile(input.provider);
  const modelLabel = aiModelOption(input.provider, input.model)?.label || input.model;
  return {
    connected: true,
    message: `${profile.shortLabel} · ${modelLabel} 连接测试通过。`,
    provider: input.provider,
    baseUrl: input.baseUrl,
    model: input.model,
    testedAt: new Date().toISOString(),
  };
}
