/**
 * AI 请求前的 prompt 日志：
 *   - 每次实际 AI 调用前打印完整 prompt / messages，方便排查「AI 返回不对」类问题；
 *   - 日志前缀 `[AI prompt]` 便于 grep，并区分既有的 `[AI]` 状态日志；
 *   - **不会**打印 apiKey / Authorization / Cookie / token / header 等敏感字段；
 *     调用方只传 messages / model / provider，**禁止**传 apiKey；
 *   - 对消息内容做防御性 redact：把形如 `apiKey=xxx` / `Bearer xxx` /
 *     `Cookie: a=b` / `token=xxx` 的字面量替换为 `[REDACTED:*]`，
 *     避免上游 prompt 模板意外夹带凭据时泄漏到日志。
 *
 * 用法：在每次真正调 `client.chat.completions.create(...)` 之前调用一次。
 */

import { logInfo } from "../../shared/log-timestamp.js";

export type AIPromptEntry =
  | "MiniMax.testConnection"
  | "MiniMax.reply"
  | "MiniMax.diagnoseAutomationFailure"
  | "MiniMax.disambiguateOption"
  | "MiniMax.regenerateSubtitle"
  | "Planner.generateStage"
  | "Planner.resolvePoiName"
  | "ThreeStage.structureLocation"
  | "ThreeStage.structureUserIntent"
  | "ThreeStage.disambiguatePoiCandidate"
  | "ThreeStage.recommendSpotNames"
  | "ThreeStage.composeVerifiedItinerary"
  | "ThreeStage.estimateVehicleTotalCost";

export interface AIPromptLogInput {
  entry: AIPromptEntry;
  provider: string;
  model: string;
  /** reply() 多次重试时附 attempt；其它入口一般不传。 */
  attempt?: number;
  messages: ReadonlyArray<{ role: string; content?: unknown }>;
}

const SENSITIVE_OBJECT_KEYS = new Set([
  "apikey", "api_key", "api-key",
  "authorization",
  "cookie", "set-cookie", "setcookie",
  "token",
  "header", "headers",
]);

const REDACTED_KEY = "[REDACTED]";

function redactString(value: string): string {
  // 仅当字面量看起来像凭据时 redact；不 redact 普通英文用法（"api key invalid" 等）。
  let out = value;
  out = out.replace(/\b(api[_\- ]?key|apikey)\s*[:=]\s*["']?[A-Za-z0-9_\-]{6,}/gi, "[REDACTED:apikey]");
  // 匹配 "Authorization: Bearer xxx" / "authorization=Bearer xxx" / 裸 "Bearer xxx"。
  out = out.replace(/(\bauthorization\s*[:=]\s*)?["']?Bearer\s+[A-Za-z0-9_\-\.=]{8,}["']?/gi, "[REDACTED:authorization]");
  out = out.replace(/\b(set-cookie|cookie)\s*:\s*[A-Za-z0-9_\-]+\s*=\s*[A-Za-z0-9_\-]+/gi, "[REDACTED:cookie]");
  out = out.replace(/\btoken\s*[:=]\s*["']?[A-Za-z0-9_\-\.]{8,}/gi, "[REDACTED:token]");
  return out;
}

function redactMessageContent(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactMessageContent);
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_OBJECT_KEYS.has(k.toLowerCase())) {
        result[k] = REDACTED_KEY;
      } else {
        result[k] = redactMessageContent(v);
      }
    }
    return result;
  }
  return value;
}

/**
 * 在真正发送 AI 请求之前调用一次：打印入口 + provider + model + (attempt) + messages。
 * 必须保证调用点不传 apiKey / baseUrl / Authorization 等凭据。
 */
export function logAIPrompt(input: AIPromptLogInput): void {
  const safeMessages = input.messages.map((m) => {
    const result: { role: string; content?: unknown } = { role: m.role };
    if ("content" in m) result.content = redactMessageContent(m.content);
    return result;
  });
  const payload: Record<string, unknown> = {
    entry: input.entry,
    provider: input.provider,
    model: input.model,
    messages: safeMessages,
  };
  if (input.attempt !== undefined) payload.attempt = input.attempt;
  // 单行 JSON 便于 grep；前缀 [AI prompt] 标识这是发给 AI 的请求内容。
  logInfo("[AI prompt]", JSON.stringify(payload));
}
