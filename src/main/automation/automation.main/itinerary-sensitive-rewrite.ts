/**
 * 行程文案自动恢复：平台以非法关键词驳回行程文案（草稿保存或审核校验）时，
 * 只重写命中的行程可见文案字段，再重跑保存 / 审核步骤。
 *
 * 约束：
 *  - 只接受命中路径的 RFC6902 replace；
 *  - 只校验命中的天标题 / 天描述 / 景点描述 / 活动标题与详情 / 餐食描述是否去掉了命中词；
 *  - 不允许修改行程天数、景点、酒店、餐食结构、POI 身份或排序（路径模型见
 *    itinerary-copy-paths.ts）。
 */
import { extractSensitiveWords } from "../../../shared/sensitive-words.js";
import type { AiResponse, ProductSummary } from "../../../shared/contracts.js";
import type { ItineraryCopyRewriter, ItineraryCopyRewriteRequest } from "../../../shared/itinerary-copy-rewrite.js";
import { buildVbkCopyPolicyPrompt, findVbkCopyBadCase } from "../../planning/vbk-copy-policy.js";
import {
  findSensitiveItineraryPaths,
  readItineraryCopy,
  writeItineraryCopy,
  type ItineraryCopyPath,
  type ItineraryCopyProduct,
} from "./itinerary-copy-paths.js";
import type { FillItineraryDraftApiResult } from "../ctrip/itinerary/api-entry.js";

export { findSensitiveItineraryPaths };
export type { ItineraryCopyPath };

type ProductWithItinerary = ItineraryCopyProduct;

export { extractSensitiveWords };

function itineraryFromResponse(response: AiResponse): NonNullable<AiResponse["patch"]> {
  if (!response.patch?.length) {
    throw new Error("AI 未返回可用于敏感词恢复的行程 patch。具体内容：/itinerary。");
  }
  return response.patch;
}

export function applySensitiveItineraryRewrite(
  product: ProductWithItinerary,
  response: AiResponse,
  sensitiveWords: readonly string[],
): void {
  const paths = findSensitiveItineraryPaths(product, sensitiveWords);
  if (!paths.length) {
    throw new Error(`平台返回非法关键词“${sensitiveWords.join("、")}”，但未能在当前行程文案中定位命中字段。`);
  }
  const allowed = new Set(paths);
  const itineraryPatch = itineraryFromResponse(response).filter((operation) => /^\/itinerary(?:\/|$)/.test(operation.path));
  if (!itineraryPatch.length || itineraryPatch.some((operation) => operation.op !== "replace"
    || !allowed.has(operation.path as ItineraryCopyPath) || typeof operation.value !== "string")) {
    throw new Error("AI 行程敏感词恢复只能 replace 命中的行程文案字段。");
  }
  const next = structuredClone(product);
  for (const operation of itineraryPatch) writeItineraryCopy(next, operation.path, operation.value as string);

  for (const path of paths) {
    const before = readItineraryCopy(product, path);
    const nextValue = readItineraryCopy(next, path);
    if (typeof nextValue !== "string" || !nextValue.trim()) {
      throw new Error(`AI 重写后行程文案为空：${path}`);
    }
    if (nextValue.trim() === String(before ?? "")) {
      throw new Error(`AI 未重写命中的行程文案字段：${path}`);
    }
    const remaining = sensitiveWords.find((word) => word && nextValue.includes(word));
    if (remaining) {
      throw new Error(`AI 重写后仍包含平台非法关键词：${remaining}`);
    }
    const policyHit = findVbkCopyBadCase(nextValue, path);
    if (policyHit) {
      throw new Error(`AI 重写后仍命中文案黑名单：${policyHit.term}`);
    }
  }

  Object.assign(product, next);
}

/** 只把命中路径与当前值交给 AI，禁止其改写其他字段。 */
export function itineraryRewriteRequest(
  product: ProductWithItinerary,
  words: readonly string[],
  paths: readonly ItineraryCopyPath[],
): ItineraryCopyRewriteRequest {
  const targets = paths.map((path) => ({ path, value: String(readItineraryCopy(product, path) ?? "") }));
  return { message: rewritePrompt(words, paths), product: structuredClone(product), targets };
}

function rewritePrompt(words: readonly string[], paths: readonly ItineraryCopyPath[]): string {
  return [
    `VBK 行程校验以非法关键词驳回：${words.join("、")}。`,
    `仅重写命中的行程文案字段：${paths.join("、")}。`,
    "保持行程天数、景点、酒店、餐食、服务时间与卡片顺序不变，不得再次出现上述词语。",
    buildVbkCopyPolicyPrompt(),
    `只返回对上述路径的 RFC6902 replace；例如 {"op":"replace","path":"${paths[0]}","value":"不含非法词的新文案"}。不得返回完整 itinerary 或任何其他路径。`,
  ].join("\n");
}

export async function fillItineraryWithSensitiveRewrite(args: {
  ctx: { itineraryCopyRewriter?: ItineraryCopyRewriter };
  localProductId: string;
  product: ProductWithItinerary;
  log: (message: string, level?: "info" | "warning" | "error") => void;
  executeItinerary: () => Promise<FillItineraryDraftApiResult>;
  dbUpdate: (localProductId: string, product: Record<string, unknown>, status: ProductSummary["status"]) => void;
}): Promise<FillItineraryDraftApiResult> {
  const maxAiRewrites = 2;
  for (let rewriteAttempt = 0; ; rewriteAttempt += 1) {
    try {
      return await args.executeItinerary();
    } catch (error) {
      const rewriter = args.ctx.itineraryCopyRewriter;
      if (!rewriter) throw error;
      if (rewriteAttempt >= maxAiRewrites) throw error;

      const sensitiveWords = extractSensitiveWords(error instanceof Error ? error.message : String(error));
      if (!sensitiveWords.length) throw error;

      const affectedPaths = findSensitiveItineraryPaths(args.product, sensitiveWords);
      if (!affectedPaths.length) throw error;
      const pathIndexPreview = affectedPaths.slice(0, 2).join("、");
      args.log(
        `VBK 行程校验拦截到非法关键词“${sensitiveWords.join("、")}”，正在调用 AI 重写行程文案${rewriteAttempt + 1}/${maxAiRewrites}（${pathIndexPreview}）`,
        "warning",
      );

      const response = await rewriter(itineraryRewriteRequest(args.product, sensitiveWords, affectedPaths));
      applySensitiveItineraryRewrite(args.product, response, sensitiveWords);
      args.dbUpdate(args.localProductId, args.product, "automating");
      args.log(`AI 已重写 ${affectedPaths.join("、")}，正在重新录入行程`, "warning");
    }
  }
}
