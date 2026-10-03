import type { AiResponse } from "../../../shared/contracts.js";
import { buildVbkCopyPolicyPrompt, findVbkCopyBadCase } from "../../planning/vbk-copy-policy.js";
import { formatProductFeaturesHtml, productFeaturesPlainText } from "../../domain/product/features-rich-text.js";
import { buildRecommendationReasonsPlan } from "../ctrip/presentation/recommendations.js";
import { hasValidVbkRecommendationLength } from "../../planning/vbk-recommendation-length.js";
import { productSchema } from "../schema/schema-definitions.js";

export type PresentationCopyPath =
  | "recommendation"
  | "features"
  | `recommendations.${number}.text`;

type ProductWithPresentation = Record<string, any> & { presentation?: Record<string, any> };

export function findSensitivePresentationPaths(
  product: ProductWithPresentation,
  sensitiveWords: readonly string[],
): PresentationCopyPath[] {
  const presentation = product.presentation ?? {};
  const candidates: Array<[PresentationCopyPath, unknown]> = [
    ["recommendation", presentation.recommendation],
    ["features", presentation.features],
    ...(Array.isArray(presentation.recommendations)
      ? presentation.recommendations.map((item: any, index: number) => [
          `recommendations.${index}.text` as PresentationCopyPath,
          item?.text,
        ] as [PresentationCopyPath, unknown])
      : []),
  ];
  const words = sensitiveWords.map((word) => word.trim()).filter(Boolean);
  return candidates
    .filter(([path, value]) => typeof value === "string" && words.some((word) => (path === "features" ? productFeaturesPlainText(value) : value).includes(word)))
    .map(([path]) => path);
}

function readPath(presentation: Record<string, any>, path: PresentationCopyPath): unknown {
  if (path === "recommendation" || path === "features") return presentation[path];
  const index = Number(path.split(".")[1]);
  return presentation.recommendations?.[index]?.text;
}

function writePath(presentation: Record<string, any>, path: PresentationCopyPath, value: string): void {
  if (path === "recommendation" || path === "features") {
    presentation[path] = value;
    return;
  }
  const index = Number(path.split(".")[1]);
  presentation.recommendations[index].text = value;
}

function presentationFromResponse(response: AiResponse): Record<string, any> {
  const operation = response.patch?.find((item) =>
    (item.op === "add" || item.op === "replace") && item.path === "/presentation",
  );
  if (!operation || typeof operation.value !== "object" || operation.value === null) {
    throw new Error("AI 未返回可用于敏感词恢复的完整产品图文文案。");
  }
  return operation.value as Record<string, any>;
}

export function applySensitivePresentationRewrite(
  product: ProductWithPresentation,
  response: AiResponse,
  affectedPaths: readonly PresentationCopyPath[],
  sensitiveWords: readonly string[],
): void {
  const current = product.presentation;
  if (!current) throw new Error("产品图文数据不存在，无法应用 AI 敏感词重写。");
  const generated = presentationFromResponse(response);
  const candidate = structuredClone(current);
  for (const path of affectedPaths) {
    const next = readPath(generated, path);
    if (typeof next !== "string" || next.trim().length === 0) {
      throw new Error(`AI 未重写敏感词命中的字段：${path}`);
    }
    const visible = path === "features" ? productFeaturesPlainText(next) : next;
    if (/[\u200b-\u200d\ufeff]/.test(visible)) throw new Error("AI 重写不得通过隐藏字符规避关键词检查。");
    const remaining = sensitiveWords.find((word) => word.trim() && visible.includes(word.trim()));
    if (remaining) throw new Error(`AI 重写后仍包含平台非法关键词：${remaining}`);
    const policyHit = findVbkCopyBadCase(visible, path);
    if (policyHit) throw new Error(`AI 重写后仍命中文案黑名单：${policyHit.term}`);
    if (path.startsWith("recommendations.") && !hasValidVbkRecommendationLength(next)) {
      throw new Error(`AI 重写的推荐理由不在平台 30～84 字符范围内：${path}`);
    }
    if (path === "features") {
      const safeHtml = formatProductFeaturesHtml(next);
      if (!productFeaturesPlainText(safeHtml)) throw new Error("AI 重写后的产品特色为空。");
      if (/<[^>]+>/.test(next) && safeHtml !== next.trim()) throw new Error("AI 重写后的产品特色包含不允许的 HTML。");
      const tags = (value: string) => formatProductFeaturesHtml(value).match(/<[^>]+>/g)?.join("") ?? "";
      if (tags(next) !== tags(String(current.features))) throw new Error("AI 重写不得改变产品特色的富文本结构。");
    }
    const before = String(readPath(current, path) ?? "");
    const facts = visible.match(/\d+(?:\.\d+)?|(?:含餐|含早|含午餐|含晚餐|赠送|免费|保险|保证)/g) ?? [];
    if (facts.some(fact => !before.includes(fact))) throw new Error(`AI 重写引入未经确认的权益或数值：${path}`);
    writePath(candidate, path, next.trim());
  }
  if (findSensitivePresentationPaths({ presentation: candidate }, sensitiveWords).length) {
    throw new Error("AI 重写后的图文仍包含本轮累计非法关键词。");
  }
  buildRecommendationReasonsPlan(candidate.recommendations);
  const copyShape = productSchema.shape.presentation.safeParse({
    recommendationCategory: candidate.recommendationCategory, recommendation: candidate.recommendation,
    recommendations: candidate.recommendations, features: candidate.features,
  });
  if (!copyShape.success) throw new Error("AI 重写后的产品图文不符合文案结构约束。");
  // 所有字段通过后一次性提交，避免后一个字段失败时留下半更新。
  product.presentation = candidate;
}

export function rewritePrompt(words: readonly string[], paths: readonly PresentationCopyPath[], presentation?: Record<string, any>): string {
  return [
    `VBK 平台拦截了产品图文，非法关键词：${words.join("、")}。`,
    `只重写实际命中的字段：${paths.join("、")}。`,
    "保持事实、语气、长度和其他字段不变，不得再次出现上述词语，也不要用疑似违规的夸张承诺替代。禁止新增价格、含餐、酒店档次、保险或服务权益；产品特色保持原 HTML 标签结构，只改可见文本。",
    buildVbkCopyPolicyPrompt(),
    "请通过 /presentation patch 返回完整 presentation 对象。recommendations 必须是保持原顺序的三个 {category,text} 对象组成的数组；路径中的数字是从 0 开始的数组下标，不是对象键。禁止仅返回命中条目或用 recommendations.2.text 作为对象键。",
    presentation ? `完整 value 模板（仅替换命中文本，其他值原样返回）：${JSON.stringify(presentation)}` : "",
  ].join("\n");
}
