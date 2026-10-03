/**
 * 模型与上游供应商的临时错误判定。
 *
 * 同时支持：
 *  - 结构化错误（带 `status` / `statusCode` / `code` 字段，如 Node 网络栈抛错）
 *  - 纯文本错误信息（如供应商 SDK 抛出的 message 字符串）
 *
 * 命中下列任一条件即视为「可继续重试 / 暂停等待」：
 *  - HTTP 状态码 408 / 409 / 425 / 429，或任意 5xx
 *  - Node 网络栈错误码（ECONNRESET / ECONNREFUSED / EPIPE / ETIMEDOUT / UND_ERR_*_TIMEOUT）
 *  - 文本里出现 HTTP 429 / 5xx
 *  - 文本里出现供应商侧工负载段或 provider_(connection|timeout|rate_limit)
 */

const TRANSIENT_HTTP_STATUSES: ReadonlySet<number> = new Set([408, 409, 425, 429]);

const TRANSIENT_NODE_ERROR_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
]);

const TRANSIENT_MESSAGE_PATTERN = /\b(?:HTTP\s*)?(?:429|5\d\d)\b/;
const TRANSIENT_PROVIDER_PATTERN = /服务暂时不可用|服务集群负载较高|provider_(?:connection|timeout|rate_limit)/i;

function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const obj = error as { status?: unknown; statusCode?: unknown };
  const value = obj.status ?? obj.statusCode;
  return typeof value === "number" ? value : undefined;
}

function codeOf(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const value = (error as { code?: unknown }).code;
  return typeof value === "string" ? value.toUpperCase() : "";
}

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error !== "object") return "";
  if (!error) return "";
  const value = (error as { message?: unknown }).message;
  return typeof value === "string" ? value : "";
}

export function isTransientModelError(error: unknown): boolean {
  const status = statusOf(error);
  if (status !== undefined && (TRANSIENT_HTTP_STATUSES.has(status) || status >= 500)) return true;
  if (TRANSIENT_NODE_ERROR_CODES.has(codeOf(error))) return true;
  const message = messageOf(error);
  if (!message) return false;
  return TRANSIENT_MESSAGE_PATTERN.test(message) || TRANSIENT_PROVIDER_PATTERN.test(message);
}