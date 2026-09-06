/** Parse user text for explicit, durable memory requests. */

export interface MemoryIntent {
  shouldCapture: true;
  topic: string;
  preferenceKey?: string;
  content: string;
  conditions: string[];
  raw: string;
  note?: string;
}

export interface MemoryIntentRejected {
  shouldCapture: false;
  reason: string;
  raw: string;
}

export type ParsedMemoryIntent = MemoryIntent | MemoryIntentRejected;

const SENSITIVE_PATTERNS = [
  /密码|口令|验证码|token|secret|api[_-]?key|密钥|私钥/i,
  /身份证|护照|银行卡|信用卡|CVV|银行卡号|证件/i,
  /手机号|电话号码|微信号|微信|支付宝|支付码|账户|账单/i,
];

const EXPLICIT_PATTERNS = [
  /(?:^|[\s,，。;；!?！？:：])(?:请\s*)?(?:你|你们)?(?:以后都?|今后都?|以后就?)?(?:帮我)?\s*(?:记住|记下)\s*[,，:：]?(.+)$/u,
  /(?:^|[\s,，。;；!?！？:：])(?:请\s*)?(?:你|你们)?\s*(?:以后|以后默认|以后就)\s*(?:都|默认)?\s*记住\s*[,，:：]?(.+)$/u,
  /(?:^|[\s,，。;；!?！？:：])(?:请)?\s*我\s*(?:想|希望)\s*(?:以后\s*)?(?:都)?记住\s*[,，:：]?(.+)$/u,
  /^记下\s*(.+)$/u,
  /^记住\s*(.+)$/u,
];

const TOPIC_PATTERNS: Array<[RegExp, string]> = [
  [/酒店|星级|客栈|民宿|住宿|房型/u, "hotel"],
  [/文案|话术|语气|口吻|风格|表达/u, "copywriting"],
  [/行程|景点|游玩|路线|节奏|自由活动/u, "itinerary"],
  [/用车|车辆|专车|交通|接送/u, "transport"],
  [/价格|成本|报价|预算|毛利/u, "pricing"],
  [/审核|发布|提交|合并|CI|测试/u, "workflow"],
];

const PREFERENCE_PATTERNS: Array<[RegExp, string]> = [
  [/以后|今后|长期|每次|都|默认|优先|偏好|习惯/u, "default"],
  [/不要|别|避免|禁止|不再/u, "avoid"],
  [/必须|一定|务必/u, "required"],
];

function normalizeMemoryText(value: string): string {
  return value.replace(/\s+/g, " ").replace(/^[,，。;；:：\s]+|[,，。;；\s]+$/gu, "").trim();
}

function extractExplicitContent(input: string): string | null {
  for (const pattern of EXPLICIT_PATTERNS) {
    const match = input.match(pattern);
    if (match?.[1]) return normalizeMemoryText(match[1]);
  }
  return null;
}

function classifyTopic(content: string): string {
  return TOPIC_PATTERNS.find(([pattern]) => pattern.test(content))?.[1] ?? "general";
}

function classifyPreferenceKey(content: string): string | undefined {
  return PREFERENCE_PATTERNS.find(([pattern]) => pattern.test(content))?.[1];
}

function extractConditions(content: string): string[] {
  const conditions: string[] = [];
  const whenMatch = content.match(/(?:当|如果|遇到|涉及|关于)([^，。；;]{2,60})/u);
  if (whenMatch?.[1]) conditions.push(whenMatch[1].trim());
  if (/以后|今后|默认|长期|每次|都/u.test(content)) conditions.push("长期偏好");
  return Array.from(new Set(conditions));
}

export function parseExplicitMemoryIntent(message: string): ParsedMemoryIntent {
  const raw = String(message ?? "").trim();
  if (!raw) return { shouldCapture: false, reason: "empty", raw };

  const content = extractExplicitContent(raw);
  if (!content) return { shouldCapture: false, reason: "no-explicit-memory-intent", raw };
  if (content.length < 2) return { shouldCapture: false, reason: "too-short", raw };
  if (content.length > 1000) return { shouldCapture: false, reason: "too-long", raw };
  if (SENSITIVE_PATTERNS.some((pattern) => pattern.test(content))) {
    return { shouldCapture: false, reason: "sensitive-memory-blocked", raw };
  }

  return {
    shouldCapture: true,
    topic: classifyTopic(content),
    preferenceKey: classifyPreferenceKey(content),
    content,
    conditions: extractConditions(content),
    raw,
  };
}
