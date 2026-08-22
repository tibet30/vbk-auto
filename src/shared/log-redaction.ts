import type { LogLevel, LogSource, RuntimeLogCaptureInput } from "./contracts-types.js";

const REDACTED = "[已脱敏]";
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 50;
const MAX_STRING_LENGTH = 12_000;
const TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\s*/;
const SENSITIVE_KEY = /(?:^|[_-])(api[-_]?key|password|passwd|pwd|passphrase|secret|authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|token|access[-_]?token|refresh[-_]?token|id[-_]?token|session[-_]?token|client[-_]?secret)(?:$|[_-])/i;

const STRING_PATTERNS: Array<[RegExp, string]> = [
  [/(\b(?:authorization|proxy-authorization)\b["']?\s*[:=]\s*["']?)(?:Bearer\s+|Basic\s+)?[^\s,;"'}]+/gi, `$1${REDACTED}`],
  [/(\b(?:api[-_]?key|password|passwd|pwd|passphrase|client[-_]?secret|token|access[-_]?token|refresh[-_]?token|id[-_]?token|session[-_]?token)\b["']?\s*[:=]\s*["']?)[^\s,;"'}]+/gi, `$1${REDACTED}`],
  [/(\b(?:cookie|set-cookie)\b["']?\s*[:=]\s*["']?)[^\r\n"'}]+/gi, `$1${REDACTED}`],
  [/([?&](?:api[-_]?key|token|access[-_]?token|refresh[-_]?token|password)=)[^&#\s]+/gi, `$1${REDACTED}`],
];

export function redactLogString(value: string): string {
  let safe = value;
  for (const [pattern, replacement] of STRING_PATTERNS) safe = safe.replace(pattern, replacement);
  return safe.length > MAX_STRING_LENGTH ? `${safe.slice(0, MAX_STRING_LENGTH)}…[已截断]` : safe;
}

export function redactLogValue(value: unknown): unknown {
  return redactValue(value, 0, new WeakSet<object>());
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactLogString(value);
  if (typeof value === "number" || typeof value === "boolean" || value == null) return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return `[函数 ${value.name || "anonymous"}]`;
  if (typeof value === "symbol") return value.toString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactLogString(value.message),
      ...(value.stack ? { stack: redactLogString(value.stack) } : {}),
    };
  }
  if (depth >= MAX_DEPTH) return "[内容过深]";
  if (typeof value !== "object") return redactLogString(String(value));
  if (seen.has(value)) return "[循环引用]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => redactValue(item, depth + 1, seen));
  }
  const output = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
    output[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactValue(item, depth + 1, seen);
  }
  return output;
}

function displayValue(value: unknown): string {
  if (typeof value === "string") return redactLogString(value);
  const safe = redactLogValue(value);
  try {
    return JSON.stringify(safe);
  } catch {
    return redactLogString(String(safe));
  }
}

export function createRuntimeLogCapture(
  level: LogLevel,
  source: LogSource,
  args: ReadonlyArray<unknown>,
): RuntimeLogCaptureInput {
  const safeArgs = args.map((arg) => redactLogValue(arg));
  const firstText = args.length ? displayValue(args[0]).replace(TIMESTAMP_PREFIX, "") : "";
  const moduleMatch = firstText.match(/^\[([^\]]{1,64})\]/);
  const module = moduleMatch?.[1]?.trim();
  const message = args.map(displayValue).join(" ").replace(TIMESTAMP_PREFIX, "").trim() || "（空日志）";
  const context = safeArgs.length > 1
    ? { arguments: safeArgs.slice(1) }
    : typeof safeArgs[0] === "object" && safeArgs[0] !== null
      ? { value: safeArgs[0] }
      : undefined;
  return {
    level,
    source,
    occurredAt: new Date().toISOString(),
    message,
    ...(module ? { module } : {}),
    ...(context ? { context } : {}),
  };
}

export function sanitizeRuntimeLogCapture(input: RuntimeLogCaptureInput): RuntimeLogCaptureInput {
  const context = redactLogValue(input.context);
  const levels: LogLevel[] = ["debug", "info", "warn", "error"];
  const sources: LogSource[] = ["main", "renderer", "automation", "system"];
  return {
    level: levels.includes(input.level) ? input.level : "info",
    source: sources.includes(input.source) ? input.source : "system",
    occurredAt: Number.isNaN(Date.parse(input.occurredAt)) ? new Date().toISOString() : input.occurredAt,
    message: redactLogString(input.message),
    ...(input.module ? { module: redactLogString(input.module).slice(0, 64) } : {}),
    ...(context && typeof context === "object" && !Array.isArray(context)
      ? { context: context as Record<string, unknown> }
      : {}),
  };
}
