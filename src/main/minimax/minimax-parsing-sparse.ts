/**
 * MiniMax 非完整 JSON 的松散字段提取。
 */
import {
  aiResponseSchema,
  patchOperationSchema,
  researchTaskSchema,
} from "./minimax-constants.js";
import { parseRecoveredJson, extractJsonCandidate } from "./minimax-parsing-repair.js";
import { normalisePatchOperation, pathAlias } from "./minimax-parsing-value.js";
import {
  structured,
  unstructured,
  unstructuredFallbackReply,
  type ParsedMinimaxResponse,
} from "./minimax-parsing-types.js";

export function stripReplyValueWrappers(value: string): string {
  const trimmed = value.trim().replace(/^["'`]|["'`]$/g, "").trim();
  if (!trimmed) return "";
  return trimmed;
}

/**
 * 试着把一个残破 JSON 片段修复回来：原样 → 去掉尾逗号 → 修复单引号 → 补齐尾括号 / 尾引号
 * → 给未加引号的 key 加双引号等多个变体逐个尝试，第一个能 JSON.parse 通过的就返回。
 * 所有变体都失败则返回 undefined。
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
export function parseSparseResponse(raw: string): ParsedMinimaxResponse | undefined {
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
export function extractBareReplyFromText(raw: string): string | undefined {
  const matches = Array.from(raw.matchAll(/(?:^|[\s,{])(?:\"reply\"|'reply'|reply)\s*[：:]\s*([^\r\n,}\]]{1,1500})/gi));
  const rawMatch = matches.length > 0 ? matches[matches.length - 1] : null;
  if (!rawMatch || rawMatch.index === undefined) return undefined;
  return stripReplyValueWrappers(rawMatch[1]);
}

/**
 * 从半结构化文本里抓 `reply: "..."` / `reply: '...'` 的引号内字符串，处理简单转义；
 * 用于 sparse recover 阶段拿 reply 字段。
 */
export function extractLooseReplyFromRaw(raw: string): string | undefined {
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
export function extractPlainReply(raw: string): string | undefined {
  const text = raw.trim().replace(/^[`'"]|[`'"]$/g, "");
  if (!text) return undefined;
  if (text.length > 2000) return `${text.slice(0, 2000)}…`;
  return text.trim();
}

/**
 * 把 raw 中的连续空白折叠为单空格后直接当作回复内容（>1200 字按 1200 截断）。
 * 用作所有结构化解析失败后的「最后兜底」。
 */
export function extractTextFallback(raw: string): string | undefined {
  const text = raw.trim().replace(/\s{2,}/g, " ").trim();
  if (!text) return undefined;
  if (text.length > 1200) return text.slice(0, 1200);
  return text;
}
