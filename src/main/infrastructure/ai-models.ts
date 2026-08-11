/**
 * AI 模型列表拉取与解析（仅 Evolink 提供方支持）。
 *
 * 设计要点：
 *  - 不直接读数据库：通过 `readStoredKey` 回调解耦，测试可注入 mock 密钥源
 *  - HTTP 层：`fetchModels` 默认走全局 fetch，测试时可注入假实现
 *  - 解析层：`parseAiModelList` 同时支持扁平数组 / `{ data: [...] }` / `{ models: [...] }`
 *
 * 主要导出：
 *  - fetchAiModelList：发起一次远程拉取；返回 AiModelListResult 或抛出本地化错误
 *  - parseAiModelList：从原始 JSON 解析为 AiModelInfo 数组（去重、按 label 排序）
 */

import type {
  AiModelInfo,
  AiModelListInput,
  AiModelListResult,
  AiProvider,
} from "../../shared/contracts.js";
import { aiModelOption, isAiProvider } from "../../shared/contracts.js";
import { assertSafeAiServiceUrl } from "./ai-settings.js";

/** fetch 注入点，签名与全局 fetch 兼容；测试时可替换为 mock。 */
type FetchModelList = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * 拼 Evolink /models URL：先校验 baseUrl 安全，再追加 /models、清空 query/hash。
 */
function modelListUrl(baseUrl: string): URL {
  const url = assertSafeAiServiceUrl(baseUrl.trim());
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/models`;
  url.search = "";
  url.hash = "";
  return url;
}

/**
 * 把任意 unknown 转成 trim 后字符串，非字符串返回 ""。
 */
function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 把模型列表响应归一化成一个数组：支持顶层是数组 / { data } / { models } 三种结构。
 */
function modelRecords(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.data)) return record.data;
  if (Array.isArray(record.models)) return record.models;
  return [];
}

/**
 * 把模型列表 JSON 解析为 AiModelInfo 数组。
 *  - 同时识别数组、`{ data }`、`{ models }` 三种载荷；
 *  - 同一 id 多次出现只保留首个；
 *  - label 优先取 display_name / displayName / name / label，否则回退到本地 i18n，最后回退到 id；
 *  - 按 label 本地化排序。
 *
 * @param payload 任意模型列表响应
 * @param provider 提供方，用于回退 label 查找
 * @returns 去重并排序后的模型数组
 */
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

/**
 * 拉取模型列表前的 API Key 解析：
 *   - 校验 provider 合法；
 *   - input.apiKey 优先，否则回调 readStoredKey 读本地 ai-key-store；
 *   - provider ≠ "deepseek" 时拒掉（当前只支持 Evolink）。
 */
async function resolveKey(input: AiModelListInput, readStoredKey: (provider: AiProvider) => Promise<string>): Promise<string> {
  if (!isAiProvider(input?.provider)) throw new Error("请选择要刷新的 AI 提供商。");
  if (input.provider !== "deepseek") throw new Error("当前仅支持刷新 Evolink 模型列表。");
  const key = stringValue(input.apiKey) || await readStoredKey(input.provider);
  if (!key) throw new Error("请先填写 Evolink API Key。");
  return key;
}

/**
 * 把 HTTP status 翻译成本地化错误：401/403（鉴权）、429（限流）、5xx（服务端）、其它（未知）。
 * 调用方拿到 Error 后直接 throw / 抛回 IPC 层即可。
 */
function modelListHttpError(status: number): Error {
  if (status === 401 || status === 403) return new Error("Evolink API Key 无效，或无权读取模型列表。");
  if (status === 429) return new Error("Evolink 请求过于频繁，请稍后再刷新。");
  if (status >= 500) return new Error("Evolink 服务暂时不可用，请稍后再刷新模型。");
  return new Error(`Evolink 模型列表获取失败（HTTP ${status}）。`);
}

/**
 * 拉取 Evolink 模型列表（仅 Evolink 提供方支持）。
 * 抛错时已本地化为用户可读文案；调用方一般直接透传给 renderer。
 *
 * @param input 拉取输入（provider / baseUrl / 可选 apiKey）
 * @param readStoredKey 当 input.apiKey 为空时，回调读取已存储 Key
 * @param fetchModels 可选的 fetch 注入点（默认全局 fetch）
 */
export async function fetchAiModelList(
  input: AiModelListInput,
  readStoredKey: (provider: AiProvider) => Promise<string>,
  fetchModels: FetchModelList = fetch,
): Promise<AiModelListResult> {
  const apiKey = await resolveKey(input, readStoredKey);
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
