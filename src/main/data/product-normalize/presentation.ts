/**
 * product-normalize/presentation 子模块：
 *   - normaliseRecommendationItem：单条推荐语（category + text）；
 *   - normaliseCover：cover minQuality 字符串 → number；
 *   - normaliseRecommendations：3 条推荐语必须长度恰好 3、category 白名单 + 互不重复；
 *   - normalisePresentation：presentation 顶层归一化入口（recommendation/features/cover/recommendations）。
 *
 * 关键约束：
 *   - 任一条不合规 → 整个 recommendations 字段被剔除；
 *   - minQuality 必须 ≤ 5，超出删正字段；
 *   - recommendation 别名接受 recommendation / description / subtitle / productName；
 *   - features 别名接受 features / highlights / highlightsMore。
 */

import { VBK_RECOMMENDATION_CATEGORIES } from "../../domain/product/recommendation-categories.js";
import { positiveNumber, textValue } from "./helpers.js";

function normaliseRecommendationItem(value: unknown): { category: string; text: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const category = textValue(record.category);
  const text = textValue(record.text);
  if (!category || !text) return undefined;
  if (!(VBK_RECOMMENDATION_CATEGORIES as readonly string[]).includes(category)) return undefined;
  return { category, text };
}

/**
 * 旧版本或表单回写可能把封面最低质量分保存成字符串（例如 "3"）。
 * 封面会随任意手工复核字段一起经过 product schema 校验，因此这里必须在
 * 读取/写回产品时统一恢复为 number，避免删除景点等无关操作被封面脏值阻断。
 */
function normaliseCover(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const cover = { ...(value as Record<string, unknown>) };
  if ("minQuality" in cover) {
    const quality = positiveNumber(cover.minQuality);
    if (quality !== undefined && quality <= 5) cover.minQuality = quality;
    else delete cover.minQuality;
  }
  return cover;
}

/**
 * 推荐语数组校验：长度必须为 3、每条 category/text 非空且 category 在白名单、互不重复；
 * 任一条不合规返回 undefined（调用方丢掉整个 recommendations 字段）。
 */
function normaliseRecommendations(value: unknown): Array<{ category: string; text: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length !== 3) return undefined;
  const items: Array<{ category: string; text: string }> = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const item = normaliseRecommendationItem(entry);
    if (!item) return undefined;
    if (seen.has(item.category)) return undefined;
    seen.add(item.category);
    items.push(item);
  }
  return items;
}

/**
 * 归一化产品 presentation（推荐语 / 产品特点 / 三条推荐）。
 *  - 推荐语接受 recommendation / description / subtitle / productName 多种别名；
 *  - features 接受 features / highlights / highlightsMore；
 *  - 三条推荐必须长度恰好为 3、类别在白名单、互不重复，否则整个 recommendations 字段被剔除；
 *  - 返回 undefined 表示该结构不可用，调用方应当丢弃。
 */
export function normalisePresentation(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const highlights = Array.isArray(record.highlights) ? record.highlights.map(textValue).filter(Boolean) : [];
  const recommendation = textValue(record.recommendation) || textValue(record.description) || textValue(record.subtitle) || textValue(record.productName);
  const features = textValue(record.features) || highlights.join("\n") || textValue(record.highlightsMore);
  if (!recommendation || !features) return undefined;
  const cover = normaliseCover(record.cover);
  const recommendations = normaliseRecommendations(record.recommendations);
  return {
    recommendationCategory: textValue(record.recommendationCategory) || "优选行程",
    recommendation,
    features,
    ...(recommendations ? { recommendations } : {}),
    ...(cover ? { cover } : {}),
  };
}