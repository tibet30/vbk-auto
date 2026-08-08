import type {
  AiModelInfo,
  AiModelListInput,
  AiModelListResult,
  AiProvider,
} from "../../shared/contracts.js";
import { aiModelOption, isAiProvider } from "../../shared/contracts.js";
import { assertSafeAiServiceUrl } from "./ai-settings.js";

type FetchModelList = (input: string | URL, init?: RequestInit) => Promise<Response>;

function modelListUrl(baseUrl: string): URL {
  const url = assertSafeAiServiceUrl(baseUrl.trim());
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/models`;
  url.search = "";
  url.hash = "";
  return url;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function modelRecords(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.data)) return record.data;
  if (Array.isArray(record.models)) return record.models;
  return [];
}

export function parseAiModelList(payload: unknown, provider: AiProvider): AiModelInfo[] {
  const seen = new Set<string>();
  const models: AiModelInfo[] = [];
  for (const entry of modelRecords(payload).slice(0, 1_000)) {
    const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : null;
    const id = stringValue(typeof entry === "string" ? entry : record?.id ?? record?.model);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const providerLabel = aiModelOption(provider, id)?.label;
    const label = stringValue(record?.display_name ?? record?.displayName ?? record?.name ?? record?.label)
      || providerLabel
      || id;
    const ownedBy = stringValue(record?.owned_by ?? record?.ownedBy ?? record?.provider);
    models.push({ id, label, ...(ownedBy ? { ownedBy } : {}) });
  }
  return models.sort((a, b) => a.label.localeCompare(b.label, "zh-CN", { numeric: true }));
}

function resolveKey(input: AiModelListInput, readStoredKey: (provider: AiProvider) => string): string {
  if (!isAiProvider(input?.provider)) throw new Error("请选择要刷新的 AI 提供商。");
  if (input.provider !== "deepseek") throw new Error("当前仅支持刷新 Evolink 模型列表。");
  const key = stringValue(input.apiKey) || readStoredKey(input.provider);
  if (!key) throw new Error("请先填写 Evolink API Key。");
  return key;
}

function modelListHttpError(status: number): Error {
  if (status === 401 || status === 403) return new Error("Evolink API Key 无效，或无权读取模型列表。");
  if (status === 429) return new Error("Evolink 请求过于频繁，请稍后再刷新。");
  if (status >= 500) return new Error("Evolink 服务暂时不可用，请稍后再刷新模型。");
  return new Error(`Evolink 模型列表获取失败（HTTP ${status}）。`);
}

export async function fetchAiModelList(
  input: AiModelListInput,
  readStoredKey: (provider: AiProvider) => string,
  fetchModels: FetchModelList = fetch,
): Promise<AiModelListResult> {
  const apiKey = resolveKey(input, readStoredKey);
  let response: Response;
  try {
    response = await fetchModels(modelListUrl(input.baseUrl), {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error("Evolink 模型列表请求超时，请稍后再刷新。");
    }
    throw new Error("无法连接 Evolink，请检查服务地址和网络后重试。");
  }
  if (!response.ok) throw modelListHttpError(response.status);

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Evolink 返回的模型列表格式不正确，请稍后重试。");
  }
  const models = parseAiModelList(payload, input.provider);
  if (!models.length) throw new Error("当前 Evolink API Key 没有返回可用模型。");
  return { models, fetchedAt: new Date().toISOString() };
}
