/** 只从平台明确的非法词反馈提取词列表，不把一般 Warning 当作词反馈。 */
export function extractSensitiveWords(message: string): string[] {
  if (typeof message !== "string") return [];
  const hits = [...message.matchAll(/非法(?:词|关键词)[：:]\s*([^。\n]+?)(?=\s*(?:[，,、;；]\s*请|[。\n]|$))/g)];
  const words = hits.flatMap(match => (match[1]?.split(/[、,，;；]/) ?? [])
    .map(word => word.replace(/^[\s"“”‘’'`]+|[\s"“”‘’'`]+$/g, "").replace(/[；;。.,，、]+/g, "").trim())
    .filter(Boolean));
  return [...new Set(words)];
}
