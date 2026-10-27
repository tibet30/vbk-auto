import type { AiResponse } from "../../../shared/contracts.js";
import { buildVbkCopyPolicyPrompt, findVbkCopyBadCase } from "../../planning/vbk-copy-policy.js";
import { formatProductFeaturesHtml, productFeaturesPlainText } from "../../domain/product/features-rich-text.js";
import { buildRecommendationReasonsPlan } from "../ctrip/presentation/recommendations.js";
import { hasValidVbkRecommendationLength } from "../../planning/vbk-recommendation-length.js";
import { productSchema } from "../schema/schema-definitions.js";
import { hasOutsidePoiNameMatch, trustedPresentationPoiNames } from "../../planning/vbk-copy-identity.js";
import { protectedPresentationFacts } from "./presentation-copy-facts.js";

export type PresentationCopyPath =
  | "recommendation"
  | "features"
  | `recommendations.${number}.text`;

type ProductWithPresentation = Record<string, any> & { presentation?: Record<string, any> };

function presentationCopyEntries(product: ProductWithPresentation): Array<[PresentationCopyPath, string]> {
  const presentation = product.presentation ?? {};
  const entries: Array<[PresentationCopyPath, unknown]> = [
    ["recommendation", presentation.recommendation],
    ["features", presentation.features],
    ...(Array.isArray(presentation.recommendations)
      ? presentation.recommendations.map((item: any, index: number) => [
          `recommendations.${index}.text` as PresentationCopyPath,
          item?.text,
        ] as [PresentationCopyPath, unknown])
      : []),
  ];
  return entries.filter((entry): entry is [PresentationCopyPath, string] => typeof entry[1] === "string");
}

export function findSensitivePresentationPaths(
  product: ProductWithPresentation,
  sensitiveWords: readonly string[],
  ignoreOfficialNames = false,
): PresentationCopyPath[] {
  const candidates = presentationCopyEntries(product);
  const words = sensitiveWords.map((word) => word.trim()).filter(Boolean);
  const officialPoiNames = ignoreOfficialNames ? trustedPresentationPoiNames(product) : [];
  return candidates
    .filter(([path, value]) => words.some((word) => {
      const visible = path === "features" ? productFeaturesPlainText(value) : value;
      if (!ignoreOfficialNames) return visible.includes(word);
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      return hasOutsidePoiNameMatch(visible, officialPoiNames, new RegExp(escaped, "u"));
    }))
    .map(([path]) => path);
}

/** 修复定位：平台已点名的词即使落在官方名内部，也必须在图文里改述。 */
export function findRepairablePresentationPaths(
  product: ProductWithPresentation,
  sensitiveWords: readonly string[],
): PresentationCopyPath[] {
  const protectedNames = copyProtectedPoiNames(product, sensitiveWords);
  return presentationCopyEntries(product).filter(([path, value]) => {
    const visible = path === "features" ? productFeaturesPlainText(value) : value;
    return sensitiveWords.some(word => word.trim() && hasOutsidePoiNameMatch(
      visible, protectedNames, new RegExp(word.trim().replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u")));
  }).map(([path]) => path);
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

/**
 * 平台已点名的词出现在官方名内部时，图文里保留该名称永远无法通过校验。
 * POI 身份只存在于行程 spots，图文只是引用，所以这些名称在图文中允许改述；
 * 其余官方名仍须原样保留。
 */
function copyProtectedPoiNames(product: ProductWithPresentation, sensitiveWords: readonly string[]): string[] {
  const words = sensitiveWords.map(word => word.trim()).filter(Boolean);
  return trustedPresentationPoiNames(product).filter(name => !words.some(word => name.includes(word)));
}

function referencedPoiNames(value: string, officialPoiNames: readonly string[]): string[] {
  return officialPoiNames.filter(name => value.includes(name)).sort();
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
  const officialPoiNames = copyProtectedPoiNames(product, sensitiveWords);
  for (const path of affectedPaths) {
    const next = readPath(generated, path);
    if (typeof next !== "string" || next.trim().length === 0) {
      throw new Error(`AI 未重写敏感词命中的字段：${path}`);
    }
    let acceptedValue = next.trim();
    const visible = path === "features" ? productFeaturesPlainText(next) : next;
    const beforeVisible = path === "features"
      ? productFeaturesPlainText(String(readPath(current, path) ?? ""))
      : String(readPath(current, path) ?? "");
    if (/[\u200b-\u200d\ufeff]/.test(visible)) throw new Error("AI 重写不得通过隐藏字符规避关键词检查。");
    const beforePoiNames = referencedPoiNames(beforeVisible, officialPoiNames);
    const nextPoiNames = referencedPoiNames(visible, officialPoiNames);
    if (JSON.stringify(beforePoiNames) !== JSON.stringify(nextPoiNames)) {
      throw new Error("AI 重写不得增加、删除或修改当前行程的官方 POI 引用。");
    }
    const remaining = sensitiveWords.find((word) => {
      const term = word.trim();
      if (!term) return false;
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      return hasOutsidePoiNameMatch(visible, officialPoiNames, new RegExp(escaped, "u"));
    });
    if (remaining) throw new Error(`AI 重写后仍包含平台非法关键词：${remaining}`);
    const policyHit = findVbkCopyBadCase(visible, path, officialPoiNames);
    if (policyHit) throw new Error(`AI 重写后仍命中文案黑名单：${policyHit.term}`);
    if (path.startsWith("recommendations.") && !hasValidVbkRecommendationLength(next)) {
      throw new Error(`AI 重写的推荐理由不在平台 30～84 字符范围内：${path}`);
    }
    if (path === "features") {
      const safeHtml = formatProductFeaturesHtml(next);
      if (!productFeaturesPlainText(safeHtml)) throw new Error("AI 重写后的产品特色为空。");
      if (productFeaturesPlainText(safeHtml) !== visible) {
        throw new Error("AI 重写后的产品特色包含无法安全保留的 HTML 内容。");
      }
      const tags = (value: string) => formatProductFeaturesHtml(value).match(/<[^>]+>/g)?.join("") ?? "";
      if (tags(next) !== tags(String(current.features))) throw new Error("AI 重写不得改变产品特色的富文本结构。");
      acceptedValue = safeHtml;
    }
    const before = String(readPath(current, path) ?? "");
    const beforeFacts = protectedPresentationFacts(beforeVisible);
    const nextFacts = protectedPresentationFacts(visible);
    if (JSON.stringify(beforeFacts) !== JSON.stringify(nextFacts)) {
      throw new Error(`AI 重写改变了已确认的权益或数值（含新增未经确认、删除或替换），必须返回规划重新确认：${path}`);
    }
    writePath(candidate, path, acceptedValue);
  }
  if (findRepairablePresentationPaths({ ...product, presentation: candidate }, sensitiveWords).length) {
    throw new Error("AI 重写后的图文仍包含本轮累计非法关键词。");
  }
  buildRecommendationReasonsPlan(candidate.recommendations, officialPoiNames);
  const copyShape = productSchema.shape.presentation.safeParse({
    recommendationCategory: candidate.recommendationCategory, recommendation: candidate.recommendation,
    recommendations: candidate.recommendations, features: candidate.features,
  });
  if (!copyShape.success) throw new Error("AI 重写后的产品图文不符合文案结构约束。");
  // 所有字段通过后一次性提交，避免后一个字段失败时留下半更新。
  product.presentation = candidate;
}

/** Prefer a bounded deletion for platform-named words; fall back to AI when shape/length would become invalid. */
export function applyDeterministicPresentationWordRemoval(
  product: ProductWithPresentation,
  affectedPaths: readonly PresentationCopyPath[],
  sensitiveWords: readonly string[],
): boolean {
  const current = product.presentation;
  if (!current) return false;
  const generated = structuredClone(current);
  for (const path of affectedPaths) {
    const before = readPath(generated, path);
    if (typeof before !== "string") return false;
    const after = sensitiveWords.reduce((value, word) => value.replaceAll(word.trim(), ""), before)
      .replace(/[、，,]{2,}/g, "、").replace(/\s{2,}/g, " ").trim();
    if (!after || after === before) return false;
    writePath(generated, path, after);
  }
  try {
    applySensitivePresentationRewrite(product, {
      reply: "", questions: [], researchTasks: [],
      patch: [{ op: "replace", path: "/presentation", value: generated }],
    }, affectedPaths, sensitiveWords);
    return true;
  } catch {
    return false;
  }
}

export function rewritePrompt(words: readonly string[], paths: readonly PresentationCopyPath[], presentation?: Record<string, any>): string {
  return [
    `VBK 平台拦截了产品图文，非法关键词：${words.join("、")}。`,
    `只重写实际命中的字段：${paths.join("、")}。`,
    "保持事实、语气、长度和其他字段不变，不得再次出现上述词语，也不要用疑似违规的夸张承诺替代。地点名称含上述词语时，在图文中改用不含该词的中性称呼（如“民俗古村落”），其他地点名称原样保留。禁止新增价格、含餐、酒店档次、保险或服务权益；产品特色保持原 HTML 标签结构，只改可见文本。",
    buildVbkCopyPolicyPrompt(),
    "请通过 /presentation patch 返回完整 presentation 对象。recommendations 必须是保持原顺序的三个 {category,text} 对象组成的数组；路径中的数字是从 0 开始的数组下标，不是对象键。禁止仅返回命中条目或用 recommendations.2.text 作为对象键。",
    presentation ? `完整 value 模板（仅替换命中文本，其他值原样返回）：${JSON.stringify(presentation)}` : "",
  ].join("\n");
}
