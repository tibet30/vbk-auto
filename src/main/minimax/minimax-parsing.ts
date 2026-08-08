/**
 * 把 MiniMax / Evolink 的原始模型输出解析成强类型 AiResponse 的全套工具：
 *   - 顶层入口 parseAssistantMessage（处理 tool_calls + content 两种形态）
 *   - parseJson / parseValue / unwrapResponse（结构化解析 + 自动修复）
 *   - stripInlineNoise / normalizeModelPayload / extractTopLevelJsonCandidates 等清洗工具
 *   - repairSingleQuotedJson / completeJsonTail / trimTrailingComma / quoteUnquotedKeys（修复变体）
 *   - parseSparseResponse / parseLooseFieldValue 等「松散字段提取」回退
 *
 * 设计目标：在模型返回的 JSON 不合规时尽量「救回来」（fallback），但**绝不**伪造结构化字段，
 * 救不回来的情况返回 isStructured=false 让上层决定 retry / fail。
 */

import OpenAI from "openai";
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

/**
 * 把单个 JSON Patch operation 规整为产品协议期望的形态：
 *   - 先用 pathAlias 把模型常见的变体路径（basic_info/subtitle 等）映射回标准路径；
 *   - 然后用 patchValueSchemas[path] 对 value 做严格解析；
 *   - remove 不需要 value；其它路径若解析失败返回 undefined 让上游丢弃；
 *   - 解析成功则合并 zod 的 parsed.data（缺字段会被剔除）。
 */
export function normalisePatchOperation(operation: z.infer<typeof patchOperationSchema>) {
  if (operation.op === "remove") return operation;
  // 路径变体映射：模型常把 "basic_info/subtitle" 或 "transport_mode" 等非标准路径写出，
  // 统一规整到产品协议里的可写路径。
  const alias = pathAlias(operation.path);
  if (alias !== operation.path) {
    operation = { ...operation, path: alias };
  }
  const schema = patchValueSchemas[operation.path];
  if (!schema) return operation;
  const parsed = schema.safeParse(operation.value);
  return parsed.success ? { ...operation, value: parsed.data } : undefined;
}

// 把抓包中常见的路径变体映射回产品协议的标准路径。
/**
 * 把模型写出 / 抓包中常见的路径变体（basic_info/subtitle / transport_mode / presentation/desc
 * 等）映射回 /basicInfo/subtitle、/operations/transport 等项目标准 RFC6902 路径；
 * 若以 `/` 开头原样返回，否则在前面补一个 `/`。
 */
function pathAlias(path: string): string {
  const aliases: Record<string, string> = {
    "basic_info/subtitle": "/basicInfo/subtitle",
    "basicInfo/destination": "/basicInfo/destinationCity",
    "/basic_info/subtitle": "/basicInfo/subtitle",
    "/operations/transport_mode": "/operations/transport",
    "operations/transport_mode": "/operations/transport",
    "transport-mode": "/operations/transport",
    "/transport-mode": "/operations/transport",
    "ops/transport": "/operations/transport",
    "presentation/desc": "/presentation",
    "/presentation/description": "/presentation",
  };
  if (aliases[path]) return aliases[path];
  if (!path.startsWith("/")) return `/${path}`;
  return path;
}

/**
 * 把外层包裹（如 {data: "..."} / {result: {...}} / {response: "..."}）解开，
 * 直到找到一个含 reply 字符串字段的对象为止；若顶层就是合法 AiResponse 形状则原样返回。
 * 任何一步都最多解开一层，避免无限递归。
 */
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

/**
 * 把已经解包过的对象解析为严格类型的 AiResponse：
 *   - 强制 reply 非空字符串；
 *   - patch / questions / researchTasks 必须是数组（如果存在）；
 *   - 对每个 patch 操作做 pathAlias + zod 校验；
 *   - 任何一步不通过都抛 MiniMaxServiceError("invalid_model_output")。
 */
export function parseValue(value: unknown): AiResponse {
  const unwrapped = unwrapResponse(value);
  if (!unwrapped || typeof unwrapped !== "object" || Array.isArray(unwrapped)) throw new MiniMaxServiceError("invalid_model_output", "AI 返回的数据格式无法用于产品方案，请重试。");
  const record = unwrapped as Record<string, unknown>;
  const recordKeys = Object.fromEntries(
    aiResponsePayloadKeys
      .filter((key) => Object.prototype.hasOwnProperty.call(record, key))
      .map((key) => [key, record[key]]),
  );
  const reply = typeof recordKeys.reply === "string" ? recordKeys.reply.trim() : "";
  if (!reply) throw new MiniMaxServiceError("invalid_model_output", "AI 返回的数据格式无法用于产品方案，请重试。");
  if (recordKeys.patch !== undefined && !Array.isArray(recordKeys.patch)) {
    throw new MiniMaxServiceError("invalid_model_output", "AI 返回的数据格式无法用于产品方案，请重试。");
  }
  if (recordKeys.questions !== undefined && !Array.isArray(recordKeys.questions)) {
    throw new MiniMaxServiceError("invalid_model_output", "AI 返回的数据格式无法用于产品方案，请重试。");
  }
  if (recordKeys.researchTasks !== undefined && !Array.isArray(recordKeys.researchTasks)) {
    throw new MiniMaxServiceError("invalid_model_output", "AI 返回的数据格式无法用于产品方案，请重试。");
  }

  const rawPatch = Array.isArray(recordKeys.patch) ? recordKeys.patch : [];
  const patch = rawPatch
    .flatMap((operation) => {
      // 在 schema 校验前先把路径变体映射回产品协议的标准路径。
      if (operation && typeof operation === "object" && !Array.isArray(operation)) {
        const op = operation as Record<string, unknown>;
        if (typeof op.path === "string") op.path = pathAlias(op.path);
      }
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
  if (rejectedPatchPaths.length) console.warn("[AI] rejected patch paths", { paths: rejectedPatchPaths });

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
  if (!parsed.success) throw new MiniMaxServiceError("invalid_model_output", "AI 返回的数据格式无法用于产品方案，请重试。");
  return parsed.data;
}

export type ParsedMinimaxResponse = {
  response: AiResponse;
  isStructured: boolean;
};

export const unstructuredFallbackReply = "未获取到结构化内容，已记录为纯文本回复。";

/**
 * 把合法 AiResponse 包成 isStructured=true 的 ParsedMinimaxResponse。
 */
function structured(value: AiResponse): ParsedMinimaxResponse {
  return { response: value, isStructured: true };
}

/**
 * 把一段无结构化数据的纯文本 reply 包成 isStructured=false 的 ParsedMinimaxResponse；
 * patch / questions / researchTasks 均为空数组，对应 fallback 兜底路径。
 */
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

/**
 * 在多个候选项里挑出「最完整」的 ParseMinimaxResponse：先比 patch 数量，
 * 再看 reply 是否是「未获取到...」兜底占位（优先选非占位），
 * 最后比 reply 长度。用于从一坨修复过的 JSON 候选中选最佳结果。
 */
function pickBestStructuredResponse(responses: ParsedMinimaxResponse[]): ParsedMinimaxResponse | undefined {
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

/**
 * 去除 raw 中夹带的 JS 注释（/* ... *\/ 与 // 行内注释）以及连续空行，
 * 用于在尝试 JSON.parse 之前先清理模型输出里混入的代码片段。
 */
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
    console.warn("[AI] structured parse fallback to partial payload", {
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
    console.warn("[AI] structured parse fallback to loose reply", {
      length: raw.length,
      reason: maybeError,
    });
    return unstructured(fallbackReply);
  }
  console.warn("[AI] structured response rejected", {
    length: raw.length,
    hasThinkingBlock: /<think>/i.test(raw),
    hasJsonFence: /```(?:json)?/i.test(raw),
    reason: maybeError,
    candidatesTried: attempts.length,
  });
  return unstructured(unstructuredFallbackReply);
}

/**
 * 把 reply 字段前后的多余引号 / 反引号剥离掉（模型有时会重复包裹），
 * 用于 parseLooseFieldValue 拿到裸值之后做最后一道清洗。
 */
function stripReplyValueWrappers(value: string): string {
  const trimmed = value.trim().replace(/^["'`]|["'`]$/g, "").trim();
  if (!trimmed) return "";
  return trimmed;
}

/**
 * 试着把一个残破 JSON 片段修复回来：原样 → 去掉尾逗号 → 修复单引号 → 补齐尾括号 / 尾引号
 * → 给未加引号的 key 加双引号等多个变体逐个尝试，第一个能 JSON.parse 通过的就返回。
 * 所有变体都失败则返回 undefined。
 */
function parseRecoveredJson(raw: string): unknown | undefined {
  const withoutTrailingComma = trimTrailingComma(raw);
  console.warn("[DBG-prj2] raw[:80]=", raw.slice(0, 80));
  const candidates = [
    raw,
    withoutTrailingComma,
    repairSingleQuotedJson(raw),
    repairSingleQuotedJson(withoutTrailingComma),
    repairSingleQuotedJson(completeJsonTail(raw)),
    repairSingleQuotedJson(completeJsonTail(withoutTrailingComma)),
    completeJsonTail(raw),
    completeJsonTail(withoutTrailingComma),
    quoteUnquotedKeys(repairSingleQuotedJson(raw)),
    quoteUnquotedKeys(repairSingleQuotedJson(withoutTrailingComma)),
    quoteUnquotedKeys(repairSingleQuotedJson(completeJsonTail(raw))),
    quoteUnquotedKeys(repairSingleQuotedJson(completeJsonTail(withoutTrailingComma))),
    quoteUnquotedKeys(completeJsonTail(raw)),
    quoteUnquotedKeys(completeJsonTail(withoutTrailingComma)),
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

// 给未加引号的 key 加双引号（如 {key:value} -> {"key":"value"}）
/**
 * 用正则把 `{key:value}` / `,key:value` 这种未加引号的 key 改写成 `{"key":"value"}`，
 * 不影响已经带引号的 key，是修复单引号 JSON 的兜底步骤之一。
 */
function quoteUnquotedKeys(raw: string): string {
  return raw.replace(/([,{]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3');
}

/**
 * 从半结构化文本里抓取「key:value」形式的字段值；兼容半角 `:`/`=` 与全角 `：` 分隔符、
 * 兼容键两侧单/双引号、兼容 value 标量与嵌套 JSON；找不到时回退 value-only 解析。
 */
function parseLooseFieldValue(raw: string, key: string): unknown {
  // 兼容半角 ":" / "=" 和全角 "：" / "，" 分隔符（模型抓包常见混用中文符号）
  const normalized = raw.replace(/，/g, ",");
  const keyRegex = new RegExp(`(?:^|[\\s,，{])(?:\"${key}\"|'${key}'|${key})\\s*[：:=]\\s*`, "gi");
  const matches = Array.from(normalized.matchAll(keyRegex));
  const match = matches.length > 0 ? matches[matches.length - 1] : null;
  if (!match || match.index === undefined) {
    // raw 是 value-only 形式（如 '是否继续补齐接驳？'），尝试把 raw 当作 string 解析。
    if (/^["'].*["']$/.test(raw.trim())) {
      try {
        const v = JSON.parse(raw.trim());
        return typeof v === "string" ? v : undefined;
      } catch {}
    }
    return undefined;
  }
  // 关键：match.index 来自 normalized 字符串，但 startFrom + fragment 必须从 raw 取得。
  // raw 与 normalized 长度通常一致（只把全角逗号转半角，长度不变），index 可直接复用。
  const startFrom = match.index + match[0].length;
  const rest = raw.slice(startFrom);
  // rest 可能以单引号/双引号开头的标量字符串（如 'foo'），直接截取。
  const trimmed = rest.trim();
  if (/^["']/.test(trimmed) && !trimmed.startsWith("[") && !trimmed.startsWith("{")) {
    const quote = trimmed[0];
    const endIdx = trimmed.indexOf(quote, 1);
    if (endIdx > 0) {
      return trimmed.slice(1, endIdx);
    }
  }
  // 兼容 reply= 形式：match[0] 可能已经把开头的引号算进去了（如 `,reply='`），rest 仍是裸字符串。
  if (/^[一-鿿]/.test(trimmed) && trimmed.includes("'")) {
    const endIdx = trimmed.indexOf("'");
    if (endIdx > 0) return trimmed.slice(0, endIdx);
  }
  const start = rest.search(/[{[]/);
  if (start < 0) {
    // rest 是简单标量值（如 'foo' / "bar"），尝试整体解析。
    if (/^["'].*["']$/.test(trimmed)) {
      try {
        const v = JSON.parse(trimmed);
        return typeof v === "string" ? v : undefined;
      } catch {}
    }
    return undefined;
  }
  const fragment = extractJsonCandidate(rest, start);
  return parseRecoveredJson(fragment);
}

/**
 * 从半结构化文本里提取 patch 字段（兼容数组或单条 operation 形式），逐条做 pathAlias
 * + patchOperationSchema 校验，再走 normalisePatchOperation 规整；返回可用的 patch 数组。
 */
function parseLoosePatch(raw: string) {
  const field = parseLooseFieldValue(raw, "patch");
  if (!Array.isArray(field)) return [];
  return field.flatMap((operation) => {
    if (operation && typeof operation === "object" && !Array.isArray(operation)) {
      const op = operation as Record<string, unknown>;
      if (typeof op.path === "string") op.path = pathAlias(op.path);
    }
    const parsed = patchOperationSchema.safeParse(operation);
    if (!parsed.success) return [];
    const normalised = normalisePatchOperation(parsed.data);
    return normalised ? [normalised] : [];
  });
}

/**
 * 从半结构化文本里提取 questions 字段：数组形式时按字符串数组解析（最多保留 1 条非空），
 * 否则尝试用 extractLooseStringValueFromRaw 抓出一个裸字符串。
 */
function parseLooseQuestions(raw: string) {
  const field = parseLooseFieldValue(raw, "questions");
  if (Array.isArray(field)) {
    return field.flatMap((question) => (typeof question === "string" && question.trim() ? [question.trim()] : [])).slice(0, 1);
  }
  const question = extractLooseStringValueFromRaw(raw, "questions");
  return question ? [question] : [];
}

/**
 * 从半结构化文本里提取 researchTasks：兼容数组 / 单条对象两种形态，过 researchTaskSchema
 * 后只保留通过校验的项。
 */
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

/**
 * 从半结构化文本里抓 key 后面引号内的字符串（手动处理 \\n / \\r / \\t / \\\），返回 trim 后的内容；
 * 用于 loose-field 抽取失败时回退到「直接读字符串值」。
 */
function extractLooseStringValueFromRaw(raw: string, key: string): string | undefined {
  const match = raw.match(new RegExp(`(?:^|[\\s,，{])(?:"${key}"|'${key}'|${key})\\s*[:：=]\\s*("|')`, "i"));
  if (!match || match.index === undefined) {
    // raw 是 value-only 形式（如 '是否继续补齐接驳？'），尝试把 raw 当作 string 解析。
    if (/^["'].*["']$/.test(raw.trim())) {
      try {
        const v = JSON.parse(raw.trim());
        return typeof v === "string" ? v : undefined;
      } catch {}
    }
    return undefined;
  }
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

/**
 * 当整篇回复不构成合法 JSON 时，从松散文本里逐字段抽 patch / questions / researchTasks，
 * 任意字段命中就标记为结构化；若 reply 也抽不出来但其余字段齐全，自动补一句
 * 「未获取到正文...」的说明。全部抽空时返回 undefined。
 */
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
    ?? parseLooseFieldValue(raw, "reply")
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
  return unstructured(reply as string);
}

/**
 * 单纯从 `reply:...` 形式抓出 reply 字段值（无引号简单标量），用最后一个匹配并 stripReplyValueWrappers。
 */
function extractBareReplyFromText(raw: string): string | undefined {
  const matches = Array.from(raw.matchAll(/(?:^|[\s,{])(?:\"reply\"|'reply'|reply)\s*[：:]\s*([^\r\n,}\]]{1,1500})/gi));
  const rawMatch = matches.length > 0 ? matches[matches.length - 1] : null;
  if (!rawMatch || rawMatch.index === undefined) return undefined;
  return stripReplyValueWrappers(rawMatch[1]);
}

/**
 * 从半结构化文本里抓 `reply: "..."` / `reply: '...'` 的引号内字符串，处理简单转义；
 * 用于 sparse recover 阶段拿 reply 字段。
 */
function extractLooseReplyFromRaw(raw: string): string | undefined {
  // 用 matchAll 找所有 match，取最后一个（多片段时优先后置有效字段）。
  // 兼容半角 ":" 和全角 "：" 分隔符
  const matches = raw.matchAll(/(?:^|[,{\s])(?:"reply"|\'reply\'|reply)\s*[：:]\s*(["'])/g);
  const arr = Array.from(matches);
  const match = arr.length > 0 ? arr[arr.length - 1] : null;
  if (!match || match.index === undefined) {
    // raw 是 value-only 形式（如 '是否继续补齐接驳？'），尝试把 raw 当作 string 解析。
    if (/^["'].*["']$/.test(raw.trim())) {
      try {
        const v = JSON.parse(raw.trim());
        return typeof v === "string" ? v : undefined;
      } catch {}
    }
    return undefined;
  }
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

/**
 * 把 raw 当成纯文本 reply 直接 trim 掉前后多余引号 / 反引号返回（>2000 字按 2000 截断）。
 */
function extractPlainReply(raw: string): string | undefined {
  const text = raw.trim().replace(/^[`'"]|[`'"]$/g, "");
  if (!text) return undefined;
  if (text.length > 2000) return `${text.slice(0, 2000)}…`;
  return text.trim();
}

/**
 * 把 raw 中的连续空白折叠为单空格后直接当作回复内容（>1200 字按 1200 截断）。
 * 用作所有结构化解析失败后的「最后兜底」。
 */
function extractTextFallback(raw: string): string | undefined {
  const text = raw.trim().replace(/\s{2,}/g, " ").trim();
  if (!text) return undefined;
  if (text.length > 1200) return text.slice(0, 1200);
  return text;
}
/**
 * 从 raw 的 start 位置开始扫描，按括号配对（处理字符串与转义）截取一个完整的
 * JSON 对象片段；用于 parseLooseFieldValue 找嵌套对象。
 */
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

/**
 * 把单引号 JSON（如 {'reply': 'hi'}）的字符串部分统一改写成双引号，并把单引号字符串内的
 * 双引号转义，避免被外层双引号包裹冲突；不做语法修复，仅做引号转换。
 */
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

/**
 * 给截断的 JSON 自动补齐缺失的尾括号 / 尾引号（按配对栈推算），让 JSON.parse 不至于因为
 * 末尾缺失 `}` `]` 而抛错；不能识别的错位括号会原样返回 raw。
 */
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

/**
 * 删除 JSON 中 `[...,]` / `{...,}` 这类拖尾逗号；属于最常见的修复步骤之一。
 */
function trimTrailingComma(raw: string): string {
  return raw.replace(/,\s*(?=[}\]])/g, "");
}

/**
 * 把 OpenAI Chat Completion 的一条 message 解析为 ParsedMinimaxResponse（结构化 / 非结构化）：
 *   - 优先尝试官方 submit_product_update 工具调用；多个工具调用时取 patch 数最多者；
 *   - 工具名错位 / content 为 SSE 噪音时，尝试把 arguments 当松散 JSON 解析；
 *   - 最终兜底用 message.content 走 parseJson 链路。
 */
export function parseAssistantMessage(message: OpenAI.Chat.Completions.ChatCompletionMessage): ParsedMinimaxResponse {
  const allToolCalls = message.tool_calls?.filter((call): call is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall =>
    call.type === "function" && typeof call.function.arguments === "string",
  );
  const toolCalls = allToolCalls?.filter((call) => call.function.name === "submit_product_update");
  if (toolCalls?.length) {
    let fallbackRaw = "";
    const structuredToolCalls: ParsedMinimaxResponse[] = [];
    for (const toolCall of toolCalls) {
      fallbackRaw += `${toolCall.function.arguments}\n`;
      const parsed = parseJson(toolCall.function.arguments);
      if (parsed.isStructured) structuredToolCalls.push(parsed);
    }
    // 当所有官方 tool_calls arguments 都是纯文本（无结构化字段），且 patch/questions/researchTasks 都空，
    // 拼接它们作为 fallback reply。
    const allEmptyStructured = toolCalls.length > 1
      && structuredToolCalls.every((c) =>
        (c.response.patch?.length ?? 0) === 0
        && (c.response.questions?.length ?? 0) === 0
        && (c.response.researchTasks?.length ?? 0) === 0);
    if (allEmptyStructured) {
      const joined = structuredToolCalls.map((c) => c.response.reply).filter(Boolean).join("\n");
      if (joined) return unstructured(joined);
    }
    const sparseFromTools = parseSparseResponse(fallbackRaw);
    let bestToolCall = pickBestStructuredResponse(structuredToolCalls);
    // 合并多 tool_call 的字段：bestToolCall 拿到 patch/qs/rt 最多的，
    // 但若它的 reply 是 missing 占位文本，则尝试从其它 tool_call 找非占位 reply 合并过来。
    if (bestToolCall && /^未获取到/.test(bestToolCall.response.reply ?? "")) {
      const nonFallback = structuredToolCalls.find((c) => c !== bestToolCall
        && typeof c.response.reply === "string"
        && c.response.reply.trim().length > 0
        && !/^未获取到/.test(c.response.reply));
      if (nonFallback) {
        bestToolCall = {
          response: { ...bestToolCall.response, reply: nonFallback.response.reply },
          isStructured: true,
        };
      }
    }
    // 当 sparseFromTools 拼接后的结构（patch/qs/rt 总数）比 bestToolCall 更完整时优先使用 sparseFromTools。
    if (sparseFromTools?.isStructured) {
      const sparseActions = (sparseFromTools.response.patch?.length ?? 0)
        + (sparseFromTools.response.questions?.length ?? 0)
        + (sparseFromTools.response.researchTasks?.length ?? 0);
      const bestActions = bestToolCall
        ? (bestToolCall.response.patch?.length ?? 0)
          + (bestToolCall.response.questions?.length ?? 0)
          + (bestToolCall.response.researchTasks?.length ?? 0)
        : 0;
      if (sparseActions > bestActions) return sparseFromTools;
    }
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
    console.warn("[AI] tool-call arguments rejected, fallback to message content", {
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
