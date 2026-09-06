/** 从错误文案或响应头解析明确的重试等待秒数。 */
export function parseRetryAfterSeconds(input: unknown): number | undefined {
  if (typeof input === "number" && Number.isFinite(input) && input > 0) return Math.ceil(input);
  if (typeof input !== "string") return undefined;
  const text = input.trim();
  if (!text) return undefined;
  const asNumber = Number(text);
  if (Number.isFinite(asNumber) && asNumber > 0) return Math.ceil(asNumber);
  const match = text.match(/(?:请|约|等待)?\s*(\d+(?:\.\d+)?)\s*秒(?:后)?(?:再)?(?:试|重试|后)/i)
    ?? text.match(/retry[_\s-]?after\D{0,8}(\d+(?:\.\d+)?)/i);
  if (!match) return undefined;
  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.ceil(seconds);
}

export function clampRetryAfterSeconds(seconds: number, maxSeconds = 120): number {
  return Math.min(Math.max(1, Math.ceil(seconds)), maxSeconds);
}
