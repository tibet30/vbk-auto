/**
 * VBK 推荐理由长度合同。
 *
 * 模型提示词只能降低超长概率；这里负责在规划写入与平台录入两个出口做
 * 确定性收敛。优先保留完整的逗号分句；单个分句本身已超限时使用对应
 * 分类的保守短句，避免从任意字符处截断而留下残句。
 */

export const VBK_RECOMMENDATION_GENERATION_MAX_BYTES = 80;
export const VBK_RECOMMENDATION_PLATFORM_MAX_BYTES = 84;

export function vbkRecommendationByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function normalizeVbkRecommendationPunctuation(value: string): string {
  return value
    .trim()
    .replace(/[,:：;；!！?？。]/g, "，")
    .replace(/[—–]/g, "-")
    .replace(/，{2,}/g, "，")
    .replace(/，+$/g, "");
}

const CATEGORY_FALLBACKS: Readonly<Record<string, string>> = {
  优选行程: "行程安排清晰，游览节奏舒适",
  服务保障: "各环节衔接清晰，行程安排明确",
  贴心赠送: "已核实赠送权益按产品说明提供",
  精选酒店: "住宿安排舒适，方便每日出行",
  缤纷景点: "串联当地景点，兼顾风光与人文",
  特色美食: "合理安排用餐，体验当地风味",
  度假首选: "行程节奏舒适，适合从容游览",
  超值赠送: "已核实赠送权益按产品说明提供",
  五星精选: "住宿与行程衔接便利，体验舒适",
};

function safeFallback(category?: string): string {
  return CATEGORY_FALLBACKS[String(category ?? "").trim()] ?? "行程亮点安排清晰";
}

export function fitVbkRecommendationText(
  value: string,
  maxBytes = VBK_RECOMMENDATION_GENERATION_MAX_BYTES,
  category?: string,
): string {
  const normalized = normalizeVbkRecommendationPunctuation(value);
  if (!normalized || vbkRecommendationByteLength(normalized) <= maxBytes) return normalized;

  const clauses = normalized.match(/[^，-]+[，-]?/gu) ?? [normalized];
  let completePrefix = "";
  for (const clause of clauses) {
    const candidate = completePrefix + clause;
    if (vbkRecommendationByteLength(candidate) > maxBytes) break;
    completePrefix = candidate;
  }
  completePrefix = completePrefix.replace(/[，、\-\s]+$/u, "").trim();
  if (completePrefix) return completePrefix;

  const fallback = safeFallback(category);
  if (vbkRecommendationByteLength(fallback) <= maxBytes) return fallback;
  throw new Error(`VBK 推荐理由安全短句超过 ${maxBytes} UTF-8 字节。`);
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
      const category = typeof recommendation.category === "string" ? recommendation.category : undefined;
      return { ...recommendation, text: fitVbkRecommendationText(recommendation.text, undefined, category) };
    }),
  };
}
