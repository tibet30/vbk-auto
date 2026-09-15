/**
 * MiniMax 原始 JSON 修复与 parseJson 入口。
 */
import { logWarn } from "../../shared/log-timestamp.js";
import { parseValue } from "./minimax-parsing-value.js";
import {
  completeJsonTail,
  repairSingleQuotedJson,
  trimTrailingComma,
} from "./minimax-parsing-repair.js";
import {
  extractBareReplyFromText,
  extractLooseReplyFromRaw,
  extractPlainReply,
  extractTextFallback,
  parseSparseResponse,
} from "./minimax-parsing-sparse.js";
import {
  pickBestStructuredResponse,
  structured,
  unstructured,
  unstructuredFallbackReply,
  type ParsedMinimaxResponse,
} from "./minimax-parsing-types.js";

function stripInlineNoise(raw: string): string {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(?:^|\r?\n)\s*\/\/[^\n]*$/gm, " ")
    .replace(/\n{3,}/g, "\n");
}

/**
 * 把模型的纯文本输出清洗为接近合法 JSON 的形式：去掉行内注释、剥离 SSE 风格的
 * event: / data: / keep-alive / [DONE] 等噪音前缀，再把多个空行合并。
 */
function normalizeModelPayload(raw: string): string {
  return stripInlineNoise(raw)
    .replace(/^(?:\s*event:\s*[^\n]*)$/gim, "")
    .replace(/^\s*data:\s*/gim, "")
    .replace(/^\s*:\s*keep-alive\s*$/gim, "")
    .replace(/^\s*:\s*done\s*$/gim, "")
    .replace(/^\s*$/gm, "\n")
    .trim();
}

/**
 * 从 raw 的 start 位置开始，按括号配对（考虑字符串和转义）切出所有顶层 JSON / 数组片段。
 * 用于在一个回复中提取「多重结构化输出」或排除掉套娃在外的注释片段。
 */
function extractTopLevelJsonCandidates(raw: string, start: number): string[] {
  const fragments: string[] = [];
  let i = Math.max(0, start);
  while (i < raw.length) {
    const nextStart = raw.slice(i).search(/[{[]/);
    if (nextStart < 0) break;
    const candidateStart = i + nextStart;
    let inString = false;
    let escaped = false;
    let depth = 0;
    let end = -1;
    for (let j = candidateStart; j < raw.length; j += 1) {
      const ch = raw[j];
      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === "\\") {
          escaped = true;
          continue;
        }
        if (ch === "\"") inString = false;
        continue;
      }
      if (ch === "\"") {
        inString = true;
        continue;
      }
      if (ch === "{" || ch === "[") {
        depth += 1;
        continue;
      }
      if (ch === "}" || ch === "]") {
        if (depth > 0) depth -= 1;
        if (depth === 0) {
          end = j + 1;
          break;
        }
      }
    }
    const fragment = raw.slice(candidateStart, end < 0 ? raw.length : end).trim();
    if (fragment) fragments.push(fragment);
    i = end < 0 ? candidateStart + 1 : end;
  }
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const fragment of fragments) {
    if (seen.has(fragment)) continue;
    seen.add(fragment);
    unique.push(fragment);
  }
  return unique;
}

/**
 * 入口函数：把模型原始输出解析为 ParsedMinimaxResponse。
 * 完整流程：
 *   1. 清理 SSE / 代码注释噪音 + 去掉思考块 fence；
 *   2. 按顶层括号切出所有 JSON 候选项并生成 8 类修复变体（去尾逗号 / 修复单引号 / 补齐尾括号 等）；
 *   3. 任一通过 parseValue 即返回；否则降级到 sparse / 纯文本 / 兜底 reply。
 */
export function parseJson(raw: string): ParsedMinimaxResponse {
  const cleaned = normalizeModelPayload(raw.trim())
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  if (!cleaned) {
    return unstructured(unstructuredFallbackReply);
  }
  const start = cleaned.search(/[{[]/);
  if (start < 0) {
    const sparse = parseSparseResponse(cleaned);
    if (sparse) return sparse;
    const fallbackReply = extractLooseReplyFromRaw(cleaned)
      ?? extractBareReplyFromText(cleaned)
      ?? extractPlainReply(cleaned)
      ?? extractTextFallback(cleaned);
    if (fallbackReply) return unstructured(fallbackReply);
    return unstructured(unstructuredFallbackReply);
  }
  const jsonCandidates = extractTopLevelJsonCandidates(cleaned, start);
  const generatedCandidates = jsonCandidates.flatMap((json) => {
    const withoutTrailingComma = trimTrailingComma(json);
    return [
      json,
      withoutTrailingComma,
      repairSingleQuotedJson(json),
      repairSingleQuotedJson(withoutTrailingComma),
      repairSingleQuotedJson(completeJsonTail(json)),
      repairSingleQuotedJson(completeJsonTail(withoutTrailingComma)),
      completeJsonTail(json),
      completeJsonTail(withoutTrailingComma),
    ];
  });
  const candidates = generatedCandidates;
  const seen = new Set<string>();
  const attempts = candidates.filter((candidate): candidate is string => {
    if (typeof candidate !== "string") return false;
    const value = candidate.trim();
    if (!value || seen.has(value)) return false;
    seen.add(value); return true;
  });
  let lastError: unknown;
  const parsedCandidates: ParsedMinimaxResponse[] = [];
  for (const candidate of attempts) {
    if (!candidate) continue;
    try {
      parsedCandidates.push(structured(parseValue(JSON.parse(candidate))));
    } catch (error) {
      lastError = error;
    }
  }
  if (parsedCandidates.length) {
    return pickBestStructuredResponse(parsedCandidates) || parsedCandidates[0];
  }
  const maybeError = lastError instanceof Error ? lastError.message : "unknown";
  const sparseResponse = parseSparseResponse(cleaned);
  if (sparseResponse) {
    logWarn("[AI] structured parse fallback to partial payload", {
      length: raw.length,
      reason: maybeError,
      fallbackKind: sparseResponse.isStructured ? "structured-partial" : "text-only",
    });
    return sparseResponse;
  }
  const fallbackReply = extractLooseReplyFromRaw(cleaned)
    ?? extractBareReplyFromText(cleaned)
    ?? extractPlainReply(cleaned)
    ?? extractTextFallback(cleaned);
  if (fallbackReply) {
    logWarn("[AI] structured parse fallback to loose reply", {
      length: raw.length,
      reason: maybeError,
    });
    return unstructured(fallbackReply);
  }
  logWarn("[AI] structured response rejected", {
    length: raw.length,
    hasThinkingBlock: /<think>/i.test(raw),
    hasJsonFence: /```(?:json)?/i.test(raw),
    reason: maybeError,
    candidatesTried: attempts.length,
  });
  return unstructured(unstructuredFallbackReply);
}
