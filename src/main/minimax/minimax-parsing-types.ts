/**
 * MiniMax 解析结果形状与 structured/unstructured 包装。
 */
import type { AiResponse } from "../../shared/contracts.js";

export type ParsedMinimaxResponse = {
  response: AiResponse;
  isStructured: boolean;
};

export const unstructuredFallbackReply = "未获取到结构化内容，已记录为纯文本回复。";

/**
 * 把合法 AiResponse 包成 isStructured=true 的 ParsedMinimaxResponse。
 */
export function structured(value: AiResponse): ParsedMinimaxResponse {
  return { response: value, isStructured: true };
}

/**
 * 把一段无结构化数据的纯文本 reply 包成 isStructured=false 的 ParsedMinimaxResponse；
 * patch / questions / researchTasks 均为空数组，对应 fallback 兜底路径。
 */
export function unstructured(value: string): ParsedMinimaxResponse {
  return {
    response: {
      reply: value,
      patch: [],
      questions: [],
      researchTasks: [],
    },
    isStructured: false,
  };
}

/**
 * 在多个候选项里挑出「最完整」的 ParseMinimaxResponse：先比 patch 数量，
 * 再看 reply 是否是「未获取到...」兜底占位（优先选非占位），
 * 最后比 reply 长度。用于从一坨修复过的 JSON 候选中选最佳结果。
 */
export function pickBestStructuredResponse(responses: ParsedMinimaxResponse[]): ParsedMinimaxResponse | undefined {
  if (!responses.length) return undefined;
  return responses.reduce((best, candidate) => {
    const bestPatchCount = best.response.patch?.length ?? 0;
    const candidatePatchCount = candidate.response.patch?.length ?? 0;
    if (candidatePatchCount !== bestPatchCount) return candidatePatchCount > bestPatchCount ? candidate : best;
    // 当 patch 数相同时，优先选 reply 不是 "未获取到..." 兜底占位的（真正有内容的 reply）。
    const bestIsFallback = typeof best.response.reply === "string" && /^未获取到/.test(best.response.reply);
    const candidateIsFallback = typeof candidate.response.reply === "string" && /^未获取到/.test(candidate.response.reply);
    if (bestIsFallback !== candidateIsFallback) return candidateIsFallback ? best : candidate;
    return candidate.response.reply.length > best.response.reply.length ? candidate : best;
  });
}
