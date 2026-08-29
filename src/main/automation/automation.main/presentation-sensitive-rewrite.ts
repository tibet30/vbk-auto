/**
 * 产品图文敏感词自动恢复：平台返回命中词后，只找出实际包含命中词的文案字段，
 * 请求 AI 返回完整 presentation，但仅采纳这些命中字段的新文本，再重跑保存。
 */
import type { AiResponse } from "../../../shared/contracts.js";
import { PresentationSensitiveWordsError } from "../ctrip/presentation/save-monitor.js";
import { fillAndSavePresentation } from "../ctrip/presentation/main.js";
import { buildVbkCopyPolicyPrompt, findVbkCopyBadCase } from "../../planning/vbk-copy-policy.js";
import type { AutomationRunContext } from "./automation.main.context.js";

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
    .filter(([, value]) => typeof value === "string" && words.some((word) => value.includes(word)))
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
  for (const path of affectedPaths) {
    const next = readPath(generated, path);
    if (typeof next !== "string" || next.trim().length === 0) {
      throw new Error(`AI 未重写敏感词命中的字段：${path}`);
    }
    const remaining = sensitiveWords.find((word) => word.trim() && next.includes(word.trim()));
    if (remaining) throw new Error(`AI 重写后仍包含平台非法关键词：${remaining}`);
    const policyHit = findVbkCopyBadCase(next, path);
    if (policyHit) throw new Error(`AI 重写后仍命中文案黑名单：${policyHit.term}`);
    writePath(current, path, next.trim());
  }
}

function rewritePrompt(words: readonly string[], paths: readonly PresentationCopyPath[]): string {
  return [
    `VBK 平台拦截了产品图文，非法关键词：${words.join("、")}。`,
    `只重写实际命中的字段：${paths.join("、")}。`,
    "保持事实、语气、长度和其他字段不变，不得再次出现上述词语，也不要用疑似违规的夸张承诺替代。",
    buildVbkCopyPolicyPrompt(),
    "请通过 /presentation patch 返回完整 presentation 对象。",
  ].join("\n");
}

export async function fillPresentationWithSensitiveRewrite(args: {
  ctx: AutomationRunContext;
  localProductId: string;
  page: any;
  product: ProductWithPresentation;
  productId: string;
  log: (message: string, level?: "info" | "warning" | "error") => void;
}): Promise<unknown> {
  const maxAiRewrites = 2;
  for (let rewriteAttempt = 0; ; rewriteAttempt += 1) {
    try {
      return await fillAndSavePresentation(args.page, args.product, args.productId);
    } catch (error) {
      if (!(error instanceof PresentationSensitiveWordsError)) throw error;
      if (!args.ctx.presentationCopyRewriter || rewriteAttempt >= maxAiRewrites) throw error;
      const affectedPaths = findSensitivePresentationPaths(args.product, error.sensitiveWords);
      if (affectedPaths.length === 0) {
        throw new Error(`平台返回非法关键词“${error.sensitiveWords.join("、")}”，但未能在产品图文文案中定位命中字段。`);
      }
      args.log(
        `平台拦截非法关键词“${error.sensitiveWords.join("、")}”，正在调用 AI 重写 ${affectedPaths.join("、")}（${rewriteAttempt + 1}/${maxAiRewrites}）`,
        "warning",
      );
      const response = await args.ctx.presentationCopyRewriter({
        message: rewritePrompt(error.sensitiveWords, affectedPaths),
        product: args.product,
      });
      applySensitivePresentationRewrite(args.product, response, affectedPaths, error.sensitiveWords);
      args.ctx.db.updateProduct(args.localProductId, args.product, "automating");
      args.ctx.emit(args.localProductId);
      args.log(`AI 已重写 ${affectedPaths.join("、")}，正在重新录入产品图文`, "warning");
    }
  }
}
