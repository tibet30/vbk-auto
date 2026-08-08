import type { AiConnectionTestInput, AiProvider, ConnectionTest } from "../../shared/contracts.js";
import { aiModelOption, aiProviderProfile, isAiProvider } from "../../shared/contracts.js";

/**
 * AI 连接校验与 URL 安全检查。
 *
 * 供 settings.test、ai-models.fetchAiModelList 等调用方共享的解析/校验层：
 *  - assertSafeAiServiceUrl：拒绝非 https URL（仅允许 127.0.0.1 / localhost / [::1] 的 http）
 *  - resolveAiConnectionInput：合并显式传入的 apiKey 与已存储 key，构造连接测试所需参数
 *  - successfulAiConnectionTest：构造连接成功响应（不含真实 HTTP 往返）
 */

/** 已规范化、可直接用于 HTTP 调用的 AI 连接参数。 */
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

/**
 * 合并调用方传入参数与已存储的 API Key，返回一个可直接用于 HTTP 的连接参数集。
 *
 * @param input 连接测试输入（provider / baseUrl / model / apiKey）
 * @param readStoredKey 当 input.apiKey 为空时，回调读取已存储的 Key
 * @returns 规范化后的连接参数
 */
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

/**
 * 构造连接成功响应。仅做字段拼装，不实际发起请求；
 * 调用方在拿到本返回前应当已经完成一次成功的网络往返。
 *
 * @param input 已规范化的连接参数
 * @returns 构造好的 ConnectionTest（含人类可读的"连接通过"消息）
 */
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
