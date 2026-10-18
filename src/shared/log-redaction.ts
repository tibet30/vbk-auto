import type { LogLevel, LogSource, RuntimeLogCaptureInput } from "./contracts-types.js";

const REDACTED = "[已脱敏]";
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 50;
const MAX_STRING_LENGTH = 12_000;
const TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\s*/;
/**
 * 敏感字段识别（结构化对象的 key）。
 *
 * 名词本身的拼写五花八门（camelCase / kebab-case / snake_case）；用个别名
 * 列表集中匹配，比写多套分隔符更可靠。
 *
 * 必备名单：
 *   - HTTP / OAuth：authorization / cookie / csrf / signature；
 *   - 密文：password / privateKey / sshKey / credential / passphrase / secret；
 *   - API 凭证：apiKey / xApiKey / bearer / token / accessToken / refreshToken /
 *     sessionToken / idToken / clientSecret。
 *
 * 个人信息（按合规要求脱敏）：
 *   - phone / mobile / tel（与中国手机号同时脱敏）；
 *   - idCard / id-card / idcard / 身份证 / 证件号（仅在 key 头存在时匹配身份证号 18 位上下文）。
 *
 * VBK / 携程业务身份字段：
 *   - vbkAccount / loginAccount / providerId 也脱敏（防止客户/店铺 ID 与登录邮箱泄露）；
 *     “account” 本体也加入名单，避免子键（如 `vbk_account`、`vbk-account`、
 *     `vbkAccount`、`VbKAccount`）未来加进来时漏出。
 */
// 严格边界：key 整体必须等于其中一个列出的变体。
// 可变形列表上 Kebab / snake_case / camelCase / PascalCase 同写；
// 不使用「account」这样的宽子串，避免误伤 `accountName` / `myAccount`。
const SENSITIVE_KEY = new RegExp(
  "^(?:" + [
    "api[-_]?key",
    "x[-_]?api[-_]?key",
    "password",
    "passwd",
    "pwd",
    "passphrase",
    "secret",
    "client[-_]?secret",
    "authorization",
    "proxy[-_]?authorization",
    "cookie",
    "set[-_]?cookie",
    "bearer",
    "token",
    "access[-_]?token",
    "refresh[-_]?token",
    "id[-_]?token",
    "session[-_]?token",
    "csrf",
    "csrf[-_]?token",
    "signature",
    "credential",
    "private[-_]?key",
    "ssh[-_]?key",
    "phone",
    "mobile",
    "tel",
    "tele",
    "id[-_]?card",
    "idcard",
    "身份证",
    "证件号",
    "vbk[-_]?account",
    "vbk[-_]?active[-_]?account[-_]?key",
    "login[-_]?account",
    "provider[-_]?id",
    "account[-_]?key",
    "session[-_]?key",
  ].join("|") + ")$",
  "i",
);

const STRING_PATTERNS: Array<[RegExp, string]> = [
  // HTTP / OAuth 标准头
  [/(\b(?:authorization|proxy-authorization)\b["']?\s*[:=]\s*["']?)(?:Bearer\s+|Basic\s+)?[^\s,;"'}]+/gi, `$1${REDACTED}`],
  // Bearer / Basic 前缀拼接
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._\-+/=]{6,}/g, `$1 ${REDACTED}`],
  // 通用密文类字段：stop set 包含 & / ?，避免 URL query 里吞掉后续同名参数。
  [/(\b(?:api[-_]?key|x-api-key|password|passwd|pwd|passphrase|client[-_]?secret|token|access[-_]?token|refresh[-_]?token|id[-_]?token|session[-_]?token|bearer|credential|private[-_]?key|ssh[-_]?key|signature)\b["']?\s*[:=]\s*["']?)[^\s,;&?"'}]+/gi, `$1${REDACTED}`],
  // Cookie 头
  [/(\b(?:cookie|set-cookie)\b["']?\s*[:=]\s*["']?)[^\r\n"'}]+/gi, `$1${REDACTED}`],
  // URL query
  [/([?&](?:api[-_]?key|x-api-key|token|access[-_]?token|refresh[-_]?token|password|signature|credential)=)[^&#\s]+/gi, `$1${REDACTED}`],
  // 独立的 Bearer 字符串（无 key 头时，例如 "Bearer xxx" 单独出现在消息里）
  [/\bbearer\s+[A-Za-z0-9._\-+/=]{6,}/gi, `bearer ${REDACTED}`],
  // SSH private key 原文（识别 BEGIN OPENSSH/ RSA/ DSA 等头部）
  [/-----BEGIN (?:OPENSSH |RSA |DSA |EC |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:OPENSSH |RSA |DSA |EC |PGP )?PRIVATE KEY-----/g, REDACTED],
  // 中国大陆手机号（11 位 +86 或纯 1[3-9] 开头）；避免误伤普通数字串，仅在 “phone / tel / mobile” 同句子上以口令位置脱敏
  [/(\b(?:phone|tel|mobile)\b["']?\s*[:=]?\s*["']?)(?:\+?86[-\s]?)?1[3-9]\d{9}\b/gi, `$1${REDACTED}`],
  // 中国大陆身份证号（18 位 + 末位校验）；同上，仅在 key 头存在时脱敏
  [/(\b(?:id[-_]?card|身份证|证件号)\b["']?\s*[:=]?\s*["']?)[1-9]\d{16}[\dXx]\b/gi, `$1${REDACTED}`],
  // VBK / 携程业务身份（email 形式 loginAccount；纯数字 providerId；带 vbkAccount 包装）
  [/(\b(?:vbk[-_]?account|login[-_]?account)\b["']?\s*[:=]?\s*["']?)[^\s,;"'}<>]{3,}/gi, `$1${REDACTED}`],
  [/(\bprovider[-_]?id\b["']?\s*[:=]?\s*["']?)\d{4,}/gi, `$1${REDACTED}`],
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
  const output: Record<string, unknown> = {};
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
