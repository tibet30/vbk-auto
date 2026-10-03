const EDGE_SEPARATORS = /^[\s·+｜|/，,；;。:：-]+|[\s·+｜|/，,；;。:：-]+$/g;

export function stripBasicInfoIllegalKeywords(value: unknown, keywords: readonly string[]): string {
  let next = String(value ?? "");
  for (const keyword of keywords) {
    const token = String(keyword ?? "").trim();
    if (token) next = next.split(token).join("");
  }
  return next
    .replace(/([·+｜|/])\1+/g, "$1")
    .replace(/([，,；;。:：-])\1+/g, "$1")
    .replace(EDGE_SEPARATORS, "")
    .replace(/\s+/g, " ")
    .trim();
}

