/**
 * 行程敏感词自动恢复：平台拦截 saveType=3（如非法关键词）时，
 * 仅重写命中的日描述或 spots[].description，再重跑行程保存。
 *
 * 约束：
 *  - 只接受命中路径的 RFC6902 replace；
 *  - 只校验命中的 day.description 或 spots[].description 是否去掉了命中词；
 *  - 不允许修改行程天数、景点、酒店、餐食、POI 身份或排序。
 */
import type { AiResponse, ProductSummary } from "../../../shared/contracts.js";
import { buildVbkCopyPolicyPrompt, findVbkCopyBadCase } from "../../planning/vbk-copy-policy.js";
import type { ProductItineraryDay } from "../ctrip/itinerary-api/itinerary-transform.js";
import type { FillItineraryDraftApiResult } from "../ctrip/itinerary/api-entry.js";

export type ItineraryCopyPath = `/itinerary/${number}/description` | `/itinerary/${number}/spots/${number}/description`;

type ProductWithItinerary = Record<string, any> & { itinerary?: ProductItineraryDay[] };

function readItineraryDescription(product: ProductWithItinerary, path: ItineraryCopyPath): unknown {
  const match = /^\/itinerary\/(\d+)(?:\/spots\/(\d+))?\/description$/.exec(path);
  const dayIndex = Number(match?.[1]);
  if (!Number.isInteger(dayIndex) || dayIndex < 0) return undefined;
  const day = product.itinerary?.[dayIndex];
  const spotIndex = match?.[2];
  return spotIndex === undefined ? day?.description : day?.spots?.[Number(spotIndex)]?.description;
}

function sanitizeWord(word: string): string {
  return word
    .replace(/^\s*["“”‘’'`]+/, "")
    .replace(/["“”‘’'`]+\s*$/, "")
    .replace(/[；;。.,，、]+/g, "")
    .trim();
}

export function extractSensitiveWords(message: string): string[] {
  if (typeof message !== "string") return [];
  // 先取到“请修改/请更换”等平台提示之前，再按顿号/逗号拆词；
  // 否则全角顿号会被当作一次完整匹配的结束，后续词不会进入 matchAll。
  const hits = [...message.matchAll(/非法(?:词|关键词)[：:]\s*([^。\n]+?)(?=\s*(?:[，,、;；]\s*请|[。\n]|$))/g)];
  const raw = hits.flatMap((match) => {
    const words = match[1]?.split(/[、,，;；]/) ?? [];
    return words.map(sanitizeWord).filter(Boolean);
  });
  const uniq: string[] = [];
  for (const word of raw) {
    if (!uniq.includes(word)) uniq.push(word);
  }
  return uniq;
}

export function findSensitiveItineraryPaths(
  product: ProductWithItinerary,
  sensitiveWords: readonly string[],
): ItineraryCopyPath[] {
  const itinerary = product.itinerary;
  if (!Array.isArray(itinerary)) return [];
  const words = sensitiveWords.map((word) => word.trim()).filter(Boolean);
  if (!words.length) return [];

  const paths: ItineraryCopyPath[] = [];
  for (let i = 0; i < itinerary.length; i += 1) {
    const description = itinerary[i]?.description;
    if (typeof description === "string" && words.some((word) => description.includes(word))) {
      paths.push(`/itinerary/${i}/description` as ItineraryCopyPath);
    }
    const spots = itinerary[i]?.spots;
    if (!Array.isArray(spots)) continue;
    for (let spotIndex = 0; spotIndex < spots.length; spotIndex += 1) {
      const description = spots[spotIndex]?.description;
      if (typeof description === "string" && words.some((word) => description.includes(word))) {
        paths.push(`/itinerary/${i}/spots/${spotIndex}/description` as ItineraryCopyPath);
      }
    }
  }

  return paths;
}

function itineraryFromResponse(response: AiResponse): NonNullable<AiResponse["patch"]> {
  if (!response.patch?.length) {
    throw new Error("AI 未返回可用于敏感词恢复的行程 patch。具体内容：/itinerary。");
  }
  return response.patch;
}

function setItineraryDescription(product: ProductWithItinerary, path: ItineraryCopyPath, value: string): void {
  const match = /^\/itinerary\/(\d+)(?:\/spots\/(\d+))?\/description$/.exec(path);
  const day = product.itinerary?.[Number(match?.[1])];
  if (!day) throw new Error(`AI 重写目标不存在：${path}`);
  if (match?.[2] === undefined) day.description = value;
  else {
    const spot = day.spots?.[Number(match[2])];
    if (!spot) throw new Error(`AI 重写目标不存在：${path}`);
    spot.description = value;
  }
}

export function applySensitiveItineraryRewrite(
  product: ProductWithItinerary,
  response: AiResponse,
  sensitiveWords: readonly string[],
): void {
  const paths = findSensitiveItineraryPaths(product, sensitiveWords);
  if (!paths.length) {
    throw new Error(`平台返回非法关键词“${sensitiveWords.join("、")}」，但未能在当前行程中定位命中字段。`);
  }
  const allowed = new Set(paths);
  const itineraryPatch = itineraryFromResponse(response).filter((operation) => /^\/itinerary(?:\/|$)/.test(operation.path));
  if (!itineraryPatch.length || itineraryPatch.some((operation) => operation.op !== "replace" || !allowed.has(operation.path as ItineraryCopyPath) || typeof operation.value !== "string")) {
    throw new Error("AI 行程敏感词恢复只能 replace 命中的 description 字段。");
  }
  const next = structuredClone(product);
  for (const operation of itineraryPatch) setItineraryDescription(next, operation.path as ItineraryCopyPath, operation.value as string);

  for (const path of paths) {
    const before = readItineraryDescription(product, path);
    const nextValue = readItineraryDescription(next, path);
    if (typeof nextValue !== "string" || !nextValue.trim()) {
      throw new Error(`AI 重写后行程描述为空：${path}`);
    }
    if (nextValue.trim() === String(before ?? "")) {
      throw new Error(`AI 未重写命中的行程描述字段：${path}`);
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

function rewritePrompt(words: readonly string[], paths: readonly ItineraryCopyPath[]): string {
  return [
    `VBK 行程保存(saveType=3)触发非法关键词：${words.join("、")}。`,
    `仅重写命中的行程描述字段：${paths.join("、")}。`,
    "保持行程天数、景点、酒店、餐食、服务时间不变，不得再次出现上述词语。",
    buildVbkCopyPolicyPrompt(),
    `仅返回对上述路径的 RFC6902 replace；例如 {"op":"replace","path":"${paths[0]}","value":"不含非法词的新描述"}。不得返回完整 itinerary 或任何其他路径。`,
  ].join("\n");
}

export async function fillItineraryWithSensitiveRewrite(args: {
  ctx: { presentationCopyRewriter?: (req: { message: string; product: Record<string, unknown> }) => Promise<AiResponse> };
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
      if (!args.ctx.presentationCopyRewriter) throw error;
      if (rewriteAttempt >= maxAiRewrites) throw error;

      const sensitiveWords = extractSensitiveWords(error instanceof Error ? error.message : String(error));
      if (!sensitiveWords.length) throw error;

      const affectedPaths = findSensitiveItineraryPaths(args.product, sensitiveWords);
      if (!affectedPaths.length) throw error;
      const pathIndexPreview = affectedPaths.slice(0, 2).join("、");
      args.log(
        `VBK 行程校验拦截到非法关键词“${sensitiveWords.join("、")}”，正在调用 AI 重写行程描述${rewriteAttempt + 1}/${maxAiRewrites}（${pathIndexPreview}）`,
        "warning",
      );

      const response = await args.ctx.presentationCopyRewriter({
        message: rewritePrompt(sensitiveWords, affectedPaths),
        product: args.product,
      });
      applySensitiveItineraryRewrite(args.product, response, sensitiveWords);
      args.dbUpdate(args.localProductId, args.product, "automating");
      args.log(`AI 已重写 ${affectedPaths.join("、")}，正在重新录入行程`, "warning");
    }
  }
}
