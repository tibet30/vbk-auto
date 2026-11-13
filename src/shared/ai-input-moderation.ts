/**
 * 模型侧「输入内容审核拒绝」的判定。
 *
 * MiniMax 在输入侧内容审核命中时会直接返回 HTTP 422，body 形如
 * `{"type":"unprocessable_entity_error","message":"input new_sensitive (1026)"}`
 * （status_code 1026 = input new_sensitive）。这类失败与网络、鉴权、限流无关，
 * 原样重试同一份 prompt 必定再次失败，必须按「输入文本受限」单独归类并提示改写措辞。
 *
 * 判定只看可读文案，不依赖 SDK 错误类型：MiniMax / 兼容代理的 422 文案一致。
 */
const INPUT_MODERATION_PATTERN = /input[\s_-]*new[\s_-]*sensitive|new_sensitive|input_sensitive/i;

function matches(value: unknown, seen: WeakSet<object>): boolean {
  if (typeof value === "string") return INPUT_MODERATION_PATTERN.test(value);
  if (!value || typeof value !== "object") return false;
  if (seen.has(value as object)) return false;
  seen.add(value as object);
  const record = value as Record<string, unknown>;
  // Error 的 message / details 是不可枚举属性，JSON.stringify 取不到，必须直接读。
  if (typeof record.message === "string" && INPUT_MODERATION_PATTERN.test(record.message)) return true;
  if (typeof record.details === "string" && INPUT_MODERATION_PATTERN.test(record.details)) return true;
  for (const key of ["error", "body", "data", "response", "cause", "payload"]) {
    if (matches(record[key], seen)) return true;
  }
  try {
    const text = JSON.stringify(value);
    return Boolean(text) && text !== "{}" && INPUT_MODERATION_PATTERN.test(text);
  } catch {
    return false;
  }
}

/** 从错误文案或错误对象判断是否为模型侧输入审核拒绝。 */
export function isModelInputModerationMessage(value: unknown): boolean {
  return matches(value, new WeakSet<object>());
}
