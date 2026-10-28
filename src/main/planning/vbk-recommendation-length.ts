/**
 * VBK 推荐理由长度合同。
 *
 * 模型提示词只能降低超长概率；这里负责在规划写入与平台录入两个出口做
 * 确定性收敛。只保留完整的逗号分句前缀；单个分句本身已超限时抛错，
 * 不从任意字符处截断，也不替换成泛化兜底文案。
 */

export const VBK_RECOMMENDATION_GENERATION_MAX_CHARACTERS = 80;
export const VBK_RECOMMENDATION_PLATFORM_MAX_CHARACTERS = 84;

export function vbkRecommendationByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * 推荐理由有效字符数：先去除首尾空格，再按 VBK 平台标点规则归一
 * （句号/问号/叹号/冒号等统一为逗号，尾随逗号清掉），最后按平台宽度
 * 计数（Latin-1 每个码元 1，其余每个 UTF-16 码元 2）。现场中文计数为 40/84。
 */
export function vbkRecommendationCharacterLength(value: string): number {
  return normalizeVbkRecommendationPunctuation(value).replace(/[^\x00-\xff]/g, "aa").length;
}

/**
 * 推荐理由是否落在 VBK 平台 30～84 字符合同范围内：长度按字符计数，
 * 边界外一律视作无效，给录入和准备阶段提供统一的硬性闸门。
 */
export function hasValidVbkRecommendationLength(value: string): boolean {
  const length = vbkRecommendationCharacterLength(value);
  return length >= VBK_RECOMMENDATION_MIN_CHARACTERS && length <= VBK_RECOMMENDATION_PLATFORM_MAX_CHARACTERS;
}

export const VBK_RECOMMENDATION_MIN_CHARACTERS = 30;

export function normalizeVbkRecommendationPunctuation(value: string): string {
  return value
    .trim()
    .replace(/[,:：;；!！?？。]/g, "，")
    .replace(/[—–]/g, "-")
    .replace(/，{2,}/g, "，")
    .replace(/，+$/g, "");
}

/**
 * 只做截短：保留完整分句前缀；无法截出 30 字符以上的完整前缀时抛错，
 * 由调用方作为可见失败返回规划重写，绝不替换成泛化短句。
 */
export function fitVbkRecommendationText(
  value: string,
  maxCharacters = VBK_RECOMMENDATION_GENERATION_MAX_CHARACTERS,
): string {
  const normalized = normalizeVbkRecommendationPunctuation(value);
  if (!normalized) return normalized;
  const characterLength = vbkRecommendationCharacterLength(normalized);
  if (characterLength >= VBK_RECOMMENDATION_MIN_CHARACTERS && characterLength <= VBK_RECOMMENDATION_PLATFORM_MAX_CHARACTERS) return normalized;

  const clauses = normalized.match(/[^，-]+[，-]?/gu) ?? [normalized];
  let completePrefix = "";
  for (const clause of clauses) {
    const candidate = completePrefix + clause;
    if (vbkRecommendationCharacterLength(candidate) > Math.min(maxCharacters, VBK_RECOMMENDATION_PLATFORM_MAX_CHARACTERS)) break;
    completePrefix = candidate;
  }
  completePrefix = completePrefix.replace(/[，、\-\s]+$/u, "").trim();
  if (completePrefix && vbkRecommendationCharacterLength(completePrefix) >= VBK_RECOMMENDATION_MIN_CHARACTERS) return completePrefix;
  throw new Error("推荐理由超过 84 平台字符且无法按分句截短");
}

export function fitPresentationRecommendationTexts(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const presentation = value as Record<string, unknown>;
  if (!Array.isArray(presentation.recommendations)) return value;
  return {
    ...presentation,
    recommendations: presentation.recommendations.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
      const recommendation = entry as Record<string, unknown>;
      if (typeof recommendation.text !== "string") return entry;
      const normalized = normalizeVbkRecommendationPunctuation(recommendation.text);
      if (vbkRecommendationCharacterLength(normalized) <= VBK_RECOMMENDATION_PLATFORM_MAX_CHARACTERS) {
        // 过短文本原样保留，由 schema 以「不在 30～84 字符范围内」拒绝并回传重试。
        return { ...recommendation, text: normalized };
      }
      try {
        return { ...recommendation, text: fitVbkRecommendationText(recommendation.text) };
      } catch {
        // 无法按分句截短：保留原文，由 schema 拒绝并把长度原因回传给模型重写。
        return { ...recommendation, text: normalized };
      }
    }),
  };
}
