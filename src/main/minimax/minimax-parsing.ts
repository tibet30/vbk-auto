import OpenAI from "openai";
import { normaliseItinerary, normalisePresentation } from "../data/product-normalize.js";
import type { AiResponse } from "../../shared/contracts.js";
import { z } from "zod";
import {
  MiniMaxServiceError,
  aiResponsePayloadKeys,
  aiResponseSchema,
  patchOperationSchema,
  patchValueSchemas,
  researchTaskSchema,
} from "./minimax-constants.js";

export function normalisePatchOperation(operation: z.infer<typeof patchOperationSchema>) {
  if (operation.op === "remove") return operation;
  if (operation.path === "/presentation") {
    const value = normalisePresentation(operation.value);
    return value ? { ...operation, value } : undefined;
  }
  if (operation.path === "/itinerary") {
    const value = normaliseItinerary(operation.value);
    return value ? { ...operation, value } : undefined;
  }
  const schema = patchValueSchemas[operation.path];
  if (!schema) return operation;
  const parsed = schema.safeParse(operation.value);
  return parsed.success ? { ...operation, value: parsed.data } : undefined;
}

export function unwrapResponse(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (typeof record.reply === "string") return value;
  for (const key of ["data", "result", "response", "output"]) {
    const nested = record[key];
    if (typeof nested === "string") {
      const parsed = parseRecoveredJson(nested);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof (parsed as Record<string, unknown>).reply === "string") {
        return parsed;
      }
    } else if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const unwrapped = unwrapResponse(nested);
      if (unwrapped && typeof unwrapped === "object" && typeof (unwrapped as Record<string, unknown>).reply === "string") return unwrapped;
    }
  }
  return value;
}

export function parseValue(value: unknown): AiResponse {
  const unwrapped = unwrapResponse(value);
  if (!unwrapped || typeof unwrapped !== "object" || Array.isArray(unwrapped)) throw new MiniMaxServiceError("invalid_model_output", "MiniMax 返回的数据格式无法用于产品方案，请重试。");
  const record = unwrapped as Record<string, unknown>;
  const recordKeys = Object.fromEntries(
    aiResponsePayloadKeys
      .filter((key) => Object.prototype.hasOwnProperty.call(record, key))
      .map((key) => [key, record[key]]),
  );
  const reply = typeof recordKeys.reply === "string" ? recordKeys.reply.trim() : "";
  if (!reply) throw new MiniMaxServiceError("invalid_model_output", "MiniMax 返回的数据格式无法用于产品方案，请重试。");
  if (recordKeys.patch !== undefined && !Array.isArray(recordKeys.patch)) {
    throw new MiniMaxServiceError("invalid_model_output", "MiniMax 返回的数据格式无法用于产品方案，请重试。");
  }
  if (recordKeys.questions !== undefined && !Array.isArray(recordKeys.questions)) {
    throw new MiniMaxServiceError("invalid_model_output", "MiniMax 返回的数据格式无法用于产品方案，请重试。");
  }
  if (recordKeys.researchTasks !== undefined && !Array.isArray(recordKeys.researchTasks)) {
    throw new MiniMaxServiceError("invalid_model_output", "MiniMax 返回的数据格式无法用于产品方案，请重试。");
  }

  const rawPatch = Array.isArray(recordKeys.patch) ? recordKeys.patch : [];
  const patch = rawPatch
    .flatMap((operation) => {
      const parsed = patchOperationSchema.safeParse(operation);
      if (!parsed.success) return [];
      const normalised = normalisePatchOperation(parsed.data);
      return normalised ? [normalised] : [];
    });
  const rejectedPatchPaths = rawPatch.flatMap((operation) => {
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) return ["[invalid operation]"];
    const path = (operation as Record<string, unknown>).path;
    return patchOperationSchema.safeParse(operation).success ? [] : [typeof path === "string" ? path : "[missing path]"];
  });
  if (rejectedPatchPaths.length) console.warn("[MiniMax] rejected patch paths", { paths: rejectedPatchPaths });

  const questions = Array.isArray(recordKeys.questions)
    ? recordKeys.questions.filter((question): question is string => typeof question === "string" && Boolean(question.trim())).slice(0, 1)
    : [];
  const researchTasks = Array.isArray(recordKeys.researchTasks)
    ? recordKeys.researchTasks.flatMap((task) => {
      const parsed = researchTaskSchema.safeParse(task);
      return parsed.success ? [parsed.data] : [];
    })
    : [];
  const parsed = aiResponseSchema.safeParse({ reply, patch, questions, researchTasks });
  if (!parsed.success) throw new MiniMaxServiceError("invalid_model_output", "MiniMax 返回的数据格式无法用于产品方案，请重试。");
  return parsed.data;
}

export type ParsedMinimaxResponse = {
  response: AiResponse;
  isStructured: boolean;
};

export const unstructuredFallbackReply = "未获取到结构化内容，已记录为纯文本回复。";

function structured(value: AiResponse): ParsedMinimaxResponse {
  return { response: value, isStructured: true };
}

function unstructured(value: string): ParsedMinimaxResponse {
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

function pickBestStructuredResponse(responses: ParsedMinimaxResponse[]): ParsedMinimaxResponse | undefined {
  if (!responses.length) return undefined;
  console.warn("[DBG-pickBest] candidates=", responses.map((r, i) => ({ i, reply: (r.response.reply ?? "").slice(0, 20), patchLen: r.response.patch?.length ?? 0 })));
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

function stripInlineNoise(raw: string): string {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(?:^|\r?\n)\s*\/\/[^\n]*$/gm, " ")
    .replace(/\n{3,}/g, "\n");
}

function normalizeModelPayload(raw: string): string {
  return stripInlineNoise(raw)
    .replace(/^(?:\s*event:\s*[^\n]*)$/gim, "")
    .replace(/^\s*data:\s*/gim, "")
    .replace(/^\s*:\s*keep-alive\s*$/gim, "")
    .replace(/^\s*:\s*done\s*$/gim, "")
    .replace(/^\s*$/gm, "\n")
    .trim();
}

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
    console.warn("[MiniMax] structured parse fallback to partial payload", {
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
    console.warn("[MiniMax] structured parse fallback to loose reply", {
      length: raw.length,
      reason: maybeError,
    });
    return unstructured(fallbackReply);
  }
  console.warn("[MiniMax] structured response rejected", {
    length: raw.length,
    hasThinkingBlock: /<think>/i.test(raw),
    hasJsonFence: /```(?:json)?/i.test(raw),
    reason: maybeError,
    candidatesTried: attempts.length,
  });
  return unstructured(unstructuredFallbackReply);
}

function stripReplyValueWrappers(value: string): string {
  const trimmed = value.trim().replace(/^["'`]|["'`]$/g, "").trim();
  if (!trimmed) return "";
  return trimmed;
}

function parseRecoveredJson(raw: string): unknown | undefined {
  console.warn("[DBG-prj] called with raw[:80]=", raw.slice(0, 80));
  const withoutTrailingComma = trimTrailingComma(raw);
  const candidates = [
    raw,
    withoutTrailingComma,
    repairSingleQuotedJson(raw),
    repairSingleQuotedJson(withoutTrailingComma),
    repairSingleQuotedJson(completeJsonTail(raw)),
    repairSingleQuotedJson(completeJsonTail(withoutTrailingComma)),
    completeJsonTail(raw),
    completeJsonTail(withoutTrailingComma),
  ];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const value = candidate.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    try {
      return JSON.parse(value);
    } catch {}
  }
  return undefined;
}

function parseLooseFieldValue(raw: string, key: string): unknown {
  const keyRegex = new RegExp(`(?:^|[\\s,{])(?:\"${key}\"|'${key}'|${key})\\s*:\\s*`, "i");
  const match = raw.match(keyRegex);
  if (!match || match.index === undefined) return undefined;
  const startFrom = match.index + match[0].length;
  const rest = raw.slice(startFrom);
  const start = rest.search(/[{[]/);
  if (start < 0) return undefined;
  const fragment = extractJsonCandidate(rest, start);
  return parseRecoveredJson(fragment);
}

function parseLoosePatch(raw: string) {
  const field = parseLooseFieldValue(raw, "patch");
  if (!Array.isArray(field)) return [];
  return field.flatMap((operation) => {
    const parsed = patchOperationSchema.safeParse(operation);
    if (!parsed.success) return [];
    const normalised = normalisePatchOperation(parsed.data);
    return normalised ? [normalised] : [];
  });
}

function parseLooseQuestions(raw: string) {
  const field = parseLooseFieldValue(raw, "questions");
  if (Array.isArray(field)) {
    return field.flatMap((question) => (typeof question === "string" && question.trim() ? [question.trim()] : [])).slice(0, 1);
  }
  const question = extractLooseStringValueFromRaw(raw, "questions");
  return question ? [question] : [];
}

function parseLooseResearchTasks(raw: string) {
  const field = parseLooseFieldValue(raw, "researchTasks");
  if (Array.isArray(field)) {
    return field.flatMap((task) => {
      const parsed = researchTaskSchema.safeParse(task);
      return parsed.success ? [parsed.data] : [];
    });
  }
  if (!field || typeof field !== "object" || Array.isArray(field)) return [];
  const parsed = researchTaskSchema.safeParse(field);
  return parsed.success ? [parsed.data] : [];
}

function extractLooseStringValueFromRaw(raw: string, key: string): string | undefined {
  const match = raw.match(new RegExp(`(?:^|[\\s,{])(?:"${key}"|'${key}'|${key})\\s*[:：]\\s*("|')`, "i"));
  if (!match || match.index === undefined) return undefined;
  const quote = match[1];
  if (quote !== '"' && quote !== "'") return undefined;
  let i = match.index + match[0].length;
  let escaped = false;
  let value = "";
  while (i < raw.length) {
    const ch = raw[i];
    if (escaped) {
      if (ch === "n") value += "\n";
      else if (ch === "r") value += "\r";
      else if (ch === "t") value += "\t";
      else value += ch;
      escaped = false;
      i += 1;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      i += 1;
      continue;
    }
    if (ch === quote) {
      return value.trim();
    }
    if (ch === "\n" || ch === "\r") return value.trim();
    value += ch;
    i += 1;
  }
  return value.trim() ? value.trim() : undefined;
}

function parseSparseResponse(raw: string): ParsedMinimaxResponse | undefined {
  const patch = parseLoosePatch(raw);
  const questions = parseLooseQuestions(raw);
  const researchTasks = parseLooseResearchTasks(raw);
  const hasStructuredFields = patch.length + questions.length + researchTasks.length > 0;
  // 当模型只返回了 patch/questions/researchTasks 而无 reply 字段时，自动补一个 "未获取到正文..." 形式的 reply，
  // 既保证 AiResponse schema 通过校验，也提示上层这是个不完整的回复。
  const missingStructured = hasStructuredFields
    ? `未获取到正文，但已识别到 ${patch.length} 条可写更新、${questions.length} 条待确认、${researchTasks.length} 条核查任务，已记录为纯文本回复。`
    : "";
  const reply = extractLooseReplyFromRaw(raw)
    ?? extractBareReplyFromText(raw)
    ?? (hasStructuredFields ? missingStructured : undefined)
    ?? extractPlainReply(raw)
    ?? extractTextFallback(raw);
  if (!reply) return undefined;
  const candidate = {
    reply,
    patch,
    questions,
    researchTasks,
  };
  const parsed = aiResponseSchema.safeParse(candidate);
  if (parsed.success) return structured(parsed.data);
  return unstructured(reply);
}

function extractBareReplyFromText(raw: string): string | undefined {
  const rawMatch = raw.match(/(?:^|[\s,{])(?:\"reply\"|'reply'|reply)\s*[:：]\s*([^\r\n,}\]]{1,1500})/i);
  if (!rawMatch || rawMatch.index === undefined) return undefined;
  return stripReplyValueWrappers(rawMatch[1]);
}

function extractLooseReplyFromRaw(raw: string): string | undefined {
  const match = raw.match(/(?:^|[,{\s])(?:"reply"|\'reply\'|reply)\s*:\s*(["'])/);
  if (!match || match.index === undefined) return undefined;
  let start = match.index + match[0].length - 1;
  const quote = match[1];
  if (quote !== "\"" && quote !== "'") return undefined;
  let i = start + 1;
  let escaped = false;
  let value = "";
  while (i < raw.length) {
    const ch = raw[i];
    if (escaped) {
      if (ch === "n") value += "\n";
      else if (ch === "r") value += "\r";
      else if (ch === "t") value += "\t";
      else value += ch;
      escaped = false;
      i += 1;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      i += 1;
      continue;
    }
    if (ch === quote) {
      return value.trim();
    }
    if (ch === "\n" || ch === "\r") return value.trim();
    value += ch;
    i += 1;
  }
  return value.trim() ? value.trim() : undefined;
}

function extractPlainReply(raw: string): string | undefined {
  const text = raw.trim().replace(/^[`'"]|[`'"]$/g, "");
  if (!text) return undefined;
  if (text.length > 2000) return `${text.slice(0, 2000)}…`;
  return text.trim();
}

function extractTextFallback(raw: string): string | undefined {
  const text = raw.trim().replace(/\s{2,}/g, " ").trim();
  if (!text) return undefined;
  if (text.length > 1200) return text.slice(0, 1200);
  return text;
}
function extractJsonCandidate(raw: string, start: number): string {
  const fragment = raw.slice(start);
  let inString = false;
  let escaped = false;
  let depth = 0;
  for (let i = 0; i < fragment.length; i += 1) {
    const ch = fragment[i];
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
    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "[") {
      depth += 1;
      continue;
    }
    if (ch === "}" || ch === "]") {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0) return fragment.slice(0, i + 1);
      }
      continue;
    }
  }
  return fragment;
}

function repairSingleQuotedJson(raw: string): string {
  let inString: "\"" | "'" | null = null;
  let escaped = false;
  let output = "";

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];

    if (inString === null) {
      if (ch === "\"" || ch === "'") {
        inString = ch;
        output += "\"";
      } else {
        output += ch;
      }
      continue;
    }

    if (escaped) {
      if (inString === "'" && (ch === "\n" || ch === "\r" || ch === "\t" || ch === "\\")) {
        output += `\\${ch}`;
      } else if (inString === "'" && ch === "\"") {
        output += "\\\"";
      } else {
        output += ch;
      }
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      output += "\\";
      continue;
    }

    if (ch === inString) {
      output += "\"";
      inString = null;
      continue;
    }
    output += ch;
  }

  if (inString !== null) output += "\"";
  return output;
}

function completeJsonTail(raw: string): string {
  let inString = false;
  let escaped = false;
  const stack: string[] = [];
  for (const ch of raw) {
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") { inString = true; continue; }
    if (ch === "{") { stack.push("}"); continue; }
    if (ch === "[") { stack.push("]"); continue; }
    if (ch === "}") {
      if (!stack.length || stack[stack.length - 1] !== "}") return raw;
      stack.pop();
      continue;
    }
    if (ch === "]") {
      if (!stack.length || stack[stack.length - 1] !== "]") return raw;
      stack.pop();
    }
  }
  if (inString) {
    const fixedString = escaped ? raw.slice(0, -1) : raw;
    return `${fixedString}"${stack.reverse().join("")}`;
  }
  if (escaped) return `${raw}"${stack.reverse().join("")}`;
  if (!stack.length) return raw;
  return raw + stack.reverse().join("");
}

function trimTrailingComma(raw: string): string {
  return raw.replace(/,\s*(?=[}\]])/g, "");
}

export function parseAssistantMessage(message: OpenAI.Chat.Completions.ChatCompletionMessage): ParsedMinimaxResponse {
  const allToolCalls = message.tool_calls?.filter((call): call is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall =>
    call.type === "function" && typeof call.function.arguments === "string",
  );
  const toolCalls = allToolCalls?.filter((call) => call.function.name === "submit_product_update");
  if (toolCalls?.length) {
    let fallbackRaw = "";
    const structuredToolCalls: ParsedMinimaxResponse[] = [];
    console.warn("[DBG-tc] toolCalls.length=", toolCalls.length, "allToolCalls.length=", allToolCalls?.length ?? 0);
    for (const toolCall of toolCalls) {
      fallbackRaw += `${toolCall.function.arguments}\n`;
      const parsed = parseJson(toolCall.function.arguments);
      console.warn("[DBG-tc-iter] args[:80]=", toolCall.function.arguments.slice(0, 80), "isStr=", parsed.isStructured, "reply[:30]=", (parsed.response.reply ?? "").slice(0, 30));
      if (parsed.isStructured) structuredToolCalls.push(parsed);
    }
    const sparseFromTools = parseSparseResponse(fallbackRaw);
    const bestToolCall = pickBestStructuredResponse(structuredToolCalls);
    if (sparseFromTools?.isStructured && !bestToolCall) {
      return sparseFromTools;
    }
    if (!message.content) {
      const fallbackFromRaw = extractTextFallback(fallbackRaw);
      const fallbackReply = fallbackFromRaw
        ?? extractLooseReplyFromRaw(fallbackRaw)
        ?? extractBareReplyFromText(fallbackRaw)
        ?? extractPlainReply(fallbackRaw)
        ?? extractTextFallback(fallbackRaw)
        ?? unstructuredFallbackReply;
      if (bestToolCall) {
        return bestToolCall;
      }
      return unstructured(fallbackReply);
    }
    const content = typeof message.content === "string" ? message.content : "";
    if (content.trim()) {
      const parsedFromContent = parseJson(content);
      const toolPatchCount = bestToolCall?.response.patch?.length ?? 0;
      const contentPatchCount = parsedFromContent.isStructured ? (parsedFromContent.response.patch?.length ?? 0) : 0;
      if (parsedFromContent.isStructured && (!bestToolCall || contentPatchCount > toolPatchCount)) {
        return parsedFromContent;
      }
      if (bestToolCall) {
        if (!parsedFromContent.isStructured && sparseFromTools) return sparseFromTools;
        return bestToolCall;
      }
      if (sparseFromTools) {
        return sparseFromTools;
      }
      return parsedFromContent;
    }
    if (sparseFromTools) {
      return sparseFromTools;
    }
    if (bestToolCall) return bestToolCall;
    console.warn("[MiniMax] tool-call arguments rejected, fallback to message content", {
      attempts: toolCalls.length,
    });
  }
  // 当 tool_call 名字不是 submit_product_update（错位或拼错）时，只有 content 是噪音或不存在时，
  // 才回退用 tool_call arguments 解析；否则让上层 service 触发重试。
  const nonOfficialCalls = (message.tool_calls ?? []).filter((call): call is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall =>
    call.type === "function"
    && typeof call.function.arguments === "string"
    && call.function.name !== "submit_product_update",
  );
  const rawContent = typeof message.content === "string" ? message.content : "";
  const contentIsNoise = /(?:^|\n)\s*(?:event:|data:|\[DONE\]|keep-alive)/.test(rawContent);
  const contentEmpty = !rawContent.trim();
  if (nonOfficialCalls.length && (contentIsNoise || contentEmpty)) {
    const combinedArgs = nonOfficialCalls.map((call) => call.function.arguments).join("\n");
    const typoParsed = parseJson(combinedArgs);
    if (typoParsed.isStructured) return typoParsed;
    const sparseFromTypo = parseSparseResponse(combinedArgs);
    if (sparseFromTypo) return sparseFromTypo;
  }
  const content = typeof message.content === "string" ? message.content : "";
  return parseJson(content);
}
