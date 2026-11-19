/**
 * 三人同游服务端的传输层：基地址、服务令牌、信封解析与错误分类。
 *
 * 只承担「把一次 HTTPS 请求变成 (data | 明确错误)」，不解释任何业务字段——
 * 契约字段的解析放在 `tibet-service-catalog.ts` / `tibet-service-business.ts`。
 */

import { resolveTibetApiBaseUrl } from "./tibet-auth.js";
import { TIBET_SERVICE_TOKEN_ENV } from "./tibet-service-token-store.js";

export { TIBET_SERVICE_TOKEN_ENV };
const TOKEN_PREFIX = "stk_";
const REQUEST_TIMEOUT_MS = 15_000;

type FetchLike = typeof fetch;

/** 服务端信封非 200 时抛出：`code` 与 HTTP 状态一致。 */
export class TibetServiceError extends Error {
  readonly code: number;
  constructor(message: string, code: number) {
    super(message);
    this.name = "TibetServiceError";
    this.code = code;
  }
}

/** 401：令牌缺失/无效/已吊销/已过期。 */
export class TibetServiceAuthError extends TibetServiceError {
  constructor(message: string, code = 401) {
    super(message, code);
    this.name = "TibetServiceAuthError";
  }
}

/** 403：令牌有效但没有该身份或该动作的权限（例如未绑定扩展用户）。 */
export class TibetServiceScopeError extends TibetServiceError {
  constructor(message: string, code = 403) {
    super(message, code);
    this.name = "TibetServiceScopeError";
  }
}

export interface TibetTransport {
  /** 是否配置了格式合法的服务令牌。 */
  configured(): boolean;
  /** GET 请求（只读）。`path` 必须是以 `/api/` 开头、可能带查询串的相对路径。 */
  get(path: string): Promise<unknown>;
}

interface TibetEnvelope {
  code?: unknown;
  message?: unknown;
  data?: unknown;
}

export function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function strings(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    .map((item) => item.trim());
}

export function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function isValidServiceToken(token: string | undefined | null): boolean {
  const candidate = token?.trim() ?? "";
  return candidate.startsWith(TOKEN_PREFIX) && candidate.length > TOKEN_PREFIX.length;
}

export function createTibetTransport(options: {
  baseUrl?: string;
  /** 字符串直接给定；函数形式每次请求前解析（设置页保存后无需重建客户端）。 */
  token?: string | (() => string | null);
  fetchImpl?: FetchLike;
} = {}): TibetTransport {
  const baseUrl = resolveTibetApiBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const resolveToken = (): string => {
    const raw = (typeof options.token === "function"
      ? options.token()
      : options.token ?? process.env[TIBET_SERVICE_TOKEN_ENV] ?? "") ?? "";
    const trimmed = raw.trim();
    return isValidServiceToken(trimmed) ? trimmed : "";
  };

  const get = async (path: string): Promise<unknown> => {
    const headers: Record<string, string> = { Accept: "application/json" };
    const token = resolveToken();
    if (token) headers["X-Service-Token"] = token;
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new TibetServiceError("暂时无法连接三人同游服务端，请检查网络后重试。", 0);
    }
    let envelope: TibetEnvelope;
    try {
      envelope = await response.json() as TibetEnvelope;
    } catch {
      throw new TibetServiceError(
        `三人同游服务端返回了无法识别的数据（${path.split("?", 1)[0]}，HTTP ${response.status}）。`,
        response.status,
      );
    }
    const code = finiteNumber(envelope.code) ?? response.status;
    const message = text(envelope.message) ?? "三人同游服务端请求失败，请稍后重试。";
    if (code === 401 || response.status === 401) throw new TibetServiceAuthError(message);
    if (code === 403 || response.status === 403) throw new TibetServiceScopeError(message);
    if (!response.ok || code !== 200) throw new TibetServiceError(message, code);
    return envelope.data;
  };

  return { configured: () => Boolean(resolveToken()), get };
}

/** 把契约参数拼成查询串；`undefined` / 空串一律不出现。 */
export function queryString(entries: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined || value === "") continue;
    params.set(key, typeof value === "boolean" ? (value ? "1" : "0") : String(value));
  }
  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}
