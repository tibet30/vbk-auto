type Json = Record<string, unknown>;

const MESSAGE_KEYS = [
  "Message",
  "message",
  "ErrorMessage",
  "errorMessage",
  "errorMsg",
  "checkErrMsg",
  "msg",
  "Msg",
  "Description",
  "description",
] as const;

const CODE_KEYS = ["ErrorCode", "errorCode", "Code", "code"] as const;

export function vbkResponseAck(payload: unknown): string {
  return text(record(record(payload)?.ResponseStatus)?.Ack);
}

export function describeVbkFailureDetail(payload: unknown): string {
  const root = record(payload);
  const status = record(root?.ResponseStatus) ?? record(root?.responseStatus);
  const parts: string[] = [];

  for (const error of list(status?.Errors ?? status?.errors)) {
    const code = firstText(error, CODE_KEYS);
    const message = firstText(error, MESSAGE_KEYS);
    const detail = [code, message].filter(Boolean).join(": ");
    if (detail) parts.push(detail);
  }

  const statusMessage = firstText(status, MESSAGE_KEYS);
  if (statusMessage) parts.push(statusMessage);
  const rootMessage = firstText(root, MESSAGE_KEYS);
  if (rootMessage) parts.push(rootMessage);

  return truncate(unique(parts).join("；"), 800);
}

export function assertVbkAckSuccess(payload: unknown, label: string): Json {
  const root = record(payload);
  const status = record(root?.ResponseStatus) ?? record(root?.responseStatus);
  const ack = text(status?.Ack);
  const errors = list(status?.Errors ?? status?.errors);
  if (ack !== "Success" || errors.length) {
    const detail = describeVbkFailureDetail(payload);
    throw new Error(`${label}失败（Ack=${ack || "缺失"}）${detail ? `：${detail}` : ""}`);
  }
  if (!root) throw new Error(`${label}失败：响应不是对象。`);
  return root;
}

function firstText(source: Json | null, keys: readonly string[]): string {
  if (!source) return "";
  for (const key of keys) {
    const value = text(source[key]);
    if (value) return value;
  }
  return "";
}

function record(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : null;
}

function list(value: unknown): Json[] {
  return Array.isArray(value) ? value.flatMap((item) => {
    const itemRecord = record(item);
    return itemRecord ? [itemRecord] : [];
  }) : [];
}

function text(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
